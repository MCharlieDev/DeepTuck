/* DeepTuck v1.0.0 · content.js
 * 原则：内存态（WeakSet/WeakMap）+ CSS 驱动样式 + DOM 最小侵入 + 精准查询
 */
(function () {
  'use strict';

  // ============================================================
  // 配置区：选择器与文案集中管理，官方改版后只需改这里
  // ============================================================
  const MSG_SELECTOR = '.ds-message';
  const MAIN_CONTENT_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
  const THINK_CONTENT_SELECTOR = '.ds-think-content';
  const DISCLAIMER_SELECTOR = '.dbe8cf4a';
  // 分享选择界面使用的是另一套哈希类名
  const SHARE_DISCLAIMER_SELECTOR = '._0fcaa63';
  // 分享选择界面的虚拟列表专属类名：此界面为只读，无流式输出
  const SHARE_LIST_SELECTOR = '.ds-virtual-list--printable';
  const TEXTAREA_SELECTOR = 'textarea[name="search"]';

  // 思考标题容器的已知动态类名；未命中时退回最近的 div 祖先
  const THINK_HEADER_CLASSES = '._245c867, ._34a54ec';

  const THINK_LABEL_KEYWORD = '已思考';
  // 普通聊天页 / 分享选择界面 / 公开分享页的免责声明文案
  const COMPLETION_KEYWORDS = [
    '本回答由 AI 生成',
    '内容由 AI 生成',
    '内容仅供参考',
    '请仔细甄别',
  ];
  const MAX_CONTENT_HEIGHT = 240;

  const FOLD_CLASS = 'deeptuck-folded';
  const EXPAND_CLASS = 'deeptuck-expanded';
  const BTN_CLASS = 'deeptuck-fold-btn';
  const BTN_TEXT_CLASS = 'deeptuck-fold-text';
  const BTN_ICON_CLASS = 'deeptuck-fold-icon';
  const COMPOSER_CLASS = 'deeptuck-composer';
  const ACTIVE_CLASS = 'deeptuck-active';

  // ============================================================
  // 内存态：全部挂在内存里，节点被虚拟列表销毁时自动释放
  // ============================================================
  let processedMessages = new WeakSet();      // 已完成折叠判定的 .ds-message
  let handledThinkHeaders = new WeakSet();    // 已点击过的思考标题
  let thinkResolvedMessages = new WeakSet();  // 思考块已处理过的消息
  let foldedContents = new WeakSet();         // 曾被我们折叠过的正文（用于类名被 React 重置后恢复）
  let messageIdentity = new WeakMap();        // .ds-message -> 虚拟列表 key（识别节点复用）

  // 仍在流式输出、需要复查的消息（通常只有 0~2 个）
  const pendingMessages = new Set();

  let enabled = false;
  let observer = null;
  let rafId = 0;
  let composerEl = null;
  let shareView = false; // 当前是否为分享选择界面（该界面无流式输出、也常常没有免责声明）

  // ============================================================
  // 工具函数
  // ============================================================

  /** 读取虚拟列表 key，用于识别节点是否被复用 */
  function readVirtualKey(msg) {
    const item = msg.closest('[data-virtual-list-item-key]');
    return item ? item.getAttribute('data-virtual-list-item-key') : null;
  }

  /** 元素是否真实可见（用于判断思考块是否已被官方默认折叠） */
  function isVisible(el) {
    if (!el || !el.isConnected || el.hidden) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** 是否是“已思考（用时 X 秒）”这类标题文案，避免误伤正文里的同名文字 */
  function isThinkLabel(text) {
    if (!text || text.indexOf(THINK_LABEL_KEYWORD) === -1) return false;
    return (
      text.indexOf('用时') !== -1 ||
      text.indexOf('秒') !== -1 ||
      text.indexOf('（') !== -1 ||
      text.indexOf('(') !== -1
    );
  }

  /** 清理单条消息上可能残留的注入产物（节点被复用时才需要） */
  function clearArtifacts(msg) {
    const folded = msg.querySelectorAll('.' + FOLD_CLASS);
    folded.forEach(function (el) {
      el.classList.remove(FOLD_CLASS, EXPAND_CLASS);
      foldedContents.delete(el);
    });
    const buttons = msg.querySelectorAll('.' + BTN_CLASS);
    buttons.forEach(function (el) {
      el.remove();
    });
  }

  /** React 重渲染可能抹掉我们加的类名与按钮，此时需要重新折叠 */
  function artifactsLost(msg) {
    if (msg.querySelector('.' + BTN_CLASS)) return false;
    const content = msg.querySelector(MAIN_CONTENT_SELECTOR);
    if (!content) return false;
    return (content.scrollHeight || 0) > MAX_CONTENT_HEIGHT;
  }

  // ============================================================
  // 1. 思考过程折叠
  // ============================================================

  function handleThinkBlock(msg) {
    if (thinkResolvedMessages.has(msg)) return;

    // 没有思考块时直接跳过，避免无意义地扫描 span
    const thinkContent = msg.querySelector(THINK_CONTENT_SELECTOR);
    if (!thinkContent) return;

    // 先定位包含“已思考”字样的 span（只在本条消息内查找，绝不全局遍历）
    const spans = msg.querySelectorAll('span');
    let labelSpan = null;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!isThinkLabel(span.textContent)) continue;
      // 排除主回答正文里的同名文字（只排除 assistant 正文容器，避免误伤）
      if (span.closest(MAIN_CONTENT_SELECTOR)) continue;
      labelSpan = span;
      break;
    }
    if (!labelSpan) return; // 可能还处于“思考中”，等下一批 mutation 再试

    // 再 closest 到它的外层父元素（思考标题不是 button，也没有 role）
    const header =
      labelSpan.closest(THINK_HEADER_CLASSES) ||
      labelSpan.closest('div') ||
      labelSpan.parentElement;

    if (!header || typeof header.click !== 'function') return;

    thinkResolvedMessages.add(msg);

    if (handledThinkHeaders.has(header)) return;

    // 若思考正文已不可见，说明官方已默认折叠，此时点击反而会展开
    if (!isVisible(thinkContent)) {
      handledThinkHeaders.add(header);
      return;
    }

    handledThinkHeaders.add(header);
    header.click();
  }

  // ============================================================
  // 2. 回答完成判定
  // ============================================================

  function isMessageComplete(msg) {
    const selectors = [DISCLAIMER_SELECTOR, SHARE_DISCLAIMER_SELECTOR];

    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      // 最可靠信号：末尾免责声明节点（普通页 / 分享选择页各有一套哈希类名）
      if (msg.querySelector(selector)) return true;

      const next = msg.nextElementSibling;
      if (next && next.matches && next.matches(selector)) return true;

      // 免责声明可能挂在虚拟列表项这一层，而不是 .ds-message 内部
      const item = msg.closest('[data-virtual-list-item-key]');
      if (item && item.querySelector(selector)) return true;
    }

    // 降级信号：免责声明文案（兼容类名哈希变动）
    const text = msg.textContent || '';
    for (let i = 0; i < COMPLETION_KEYWORDS.length; i++) {
      if (text.indexOf(COMPLETION_KEYWORDS[i]) !== -1) return true;
    }
    return false;
  }

  // ============================================================
  // 3. 正文折叠
  // ============================================================

  /** 与原生“已思考”标题一致的折叠箭头 */
  function createFoldIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(NS, 'svg');
    icon.setAttribute('class', BTN_ICON_CLASS);
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M4.5 6.25L8 9.75l3.5-3.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.appendChild(path);

    return icon;
  }

  /** 按钮直接追加到每条对话的末尾；分享页没有原生操作栏时同样能落位 */
  function insertFoldButton(content, btn) {
    const host = content.closest(MSG_SELECTOR);
    if (host) {
      host.appendChild(btn);
      return;
    }
    // 极端结构下退回“正文后一个兄弟节点”
    content.insertAdjacentElement('afterend', btn);
  }

  function foldContent(content) {
    if (!content) return;

    const host = content.closest(MSG_SELECTOR);
    const next = content.nextElementSibling;
    const existingBtn =
      (host && host.querySelector('.' + BTN_CLASS)) ||
      (next && next.classList && next.classList.contains(BTN_CLASS));

    // 类名和按钮都在，才是完整折叠态
    if (existingBtn && content.classList.contains(FOLD_CLASS)) return;

    content.classList.add(FOLD_CLASS);
    foldedContents.add(content);

    // 类名还在、只是按钮被抹掉了：只补按钮，不动用户展开状态
    if (existingBtn) return;
    content.classList.remove(EXPAND_CLASS);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.setAttribute('aria-expanded', 'false');
    // 分享选择界面会把消息内元素的指针事件强制设为 none，内联 !important 兜底
    btn.style.setProperty('pointer-events', 'auto', 'important');

    const text = document.createElement('span');
    text.className = BTN_TEXT_CLASS;
    text.textContent = '展开全文';

    btn.appendChild(text);
    btn.appendChild(createFoldIcon());

    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleFold(content, btn);
    });

    // 关键：按钮追加在每条对话末尾，不 append 进 React 托管的 .ds-markdown 内部
    insertFoldButton(content, btn);
  }

  function toggleFold(content, btn) {
    if (!content.isConnected || !btn.isConnected) return;
    const expanded = content.classList.toggle(EXPAND_CLASS);
    const label = btn.querySelector('.' + BTN_TEXT_CLASS);
    if (label) label.textContent = expanded ? '收起' : '展开全文';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  // ============================================================
  // 4. 单条消息处理（返回 true 表示本轮已处理完毕）
  // ============================================================

  function processMessage(msg) {
    if (!enabled || !msg || !msg.isConnected) return true;

    const key = readVirtualKey(msg);

    if (processedMessages.has(msg)) {
      // 身份未变且注入产物仍在：已处理完毕
      if (messageIdentity.get(msg) === key && !artifactsLost(msg)) return true;
      // 节点被虚拟列表复用，或 React 重渲染抹掉了类名/按钮：清理后重新处理
      processedMessages.delete(msg);
      thinkResolvedMessages.delete(msg);
      clearArtifacts(msg);
    }
    messageIdentity.set(msg, key);

    // 思考块可以早于回答完成，先处理
    handleThinkBlock(msg);

    // 流式输出期间不折叠正文，等免责声明出现；
    // 分享选择界面是只读快照，没有免责声明节点，直接视为已完成
    if (!shareView && !isMessageComplete(msg)) return false;
    processedMessages.add(msg);

    const content = msg.querySelector(MAIN_CONTENT_SELECTOR);
    if (!content) return true;
    // 类名在但按钮被抹掉时，也要重新走一遍补按钮
    if (content.classList.contains(FOLD_CLASS) && msg.querySelector('.' + BTN_CLASS)) {
      return true;
    }

    const height = content.scrollHeight || 0;
    if (height > MAX_CONTENT_HEIGHT) {
      foldContent(content);
    }
    return true;
  }

  // ============================================================
  // 5. 输入框标记（只打类名，高度交给 CSS，不找父节点）
  // ============================================================

  function ensureComposer() {
    if (!enabled) return;
    if (
      composerEl &&
      composerEl.isConnected &&
      composerEl.classList.contains(COMPOSER_CLASS)
    ) {
      return;
    }
    composerEl = document.querySelector(TEXTAREA_SELECTOR);
    if (composerEl) composerEl.classList.add(COMPOSER_CLASS);
  }

  // ============================================================
  // 6. 观察与调度
  // ============================================================

  /** 从新增节点中收集“可能相关”的消息，避免整页扫描 */
  function collectCandidates(node) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.matches && node.matches(MSG_SELECTOR)) {
      pendingMessages.add(node);
    }

    const owner = node.closest ? node.closest(MSG_SELECTOR) : null;
    if (owner) pendingMessages.add(owner);

    if (node.querySelectorAll) {
      const nested = node.querySelectorAll(MSG_SELECTOR);
      nested.forEach(function (msg) {
        pendingMessages.add(msg);
      });
    }
  }

  function scheduleFlush() {
    if (rafId) return;
    rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = 0;
    if (!enabled) return;

    // 每个批次重新判定一次，进入/退出分享选择界面时都能及时切换
    shareView = !!document.querySelector(SHARE_LIST_SELECTOR);

    ensureComposer();

    pendingMessages.forEach(function (msg) {
      if (!msg || !msg.isConnected) {
        pendingMessages.delete(msg);
        return;
      }
      let done = true;
      try {
        done = processMessage(msg);
      } catch (err) {
        // 单条消息异常不影响其它消息，也避免反复重试
        console.warn('[DeepTuck] processMessage failed:', err);
        done = true;
      }
      if (done) pendingMessages.delete(msg);
    });
  }

  function handleMutations(mutations) {
    if (!enabled) return;
    let needsFlush = false;

    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];

      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(collectCandidates);
        needsFlush = true;
      } else if (mutation.type === 'characterData') {
        const parent = mutation.target && mutation.target.parentElement;
        if (!parent) continue;
        const msg = parent.closest(MSG_SELECTOR);
        if (msg) {
          pendingMessages.add(msg);
          needsFlush = true;
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (!target || target.nodeType !== 1) continue;

        // 普通聊天列表 ↔ 分享选择列表切换（只改 class 时也要刷新 shareView）
        if (target.classList && target.classList.contains('ds-virtual-list')) {
          needsFlush = true;
        }

        // React 重渲染可能把 deeptuck-folded 类名整个重置掉（不会触发 childList）
        if (!target.matches || !target.matches(MAIN_CONTENT_SELECTOR)) continue;
        if (!foldedContents.has(target)) continue;
        if (target.classList.contains(FOLD_CLASS)) continue;

        target.classList.add(FOLD_CLASS);
        const msg = target.closest(MSG_SELECTOR);
        const btn = msg ? msg.querySelector('.' + BTN_CLASS) : null;

        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          const label = btn.querySelector('.' + BTN_TEXT_CLASS);
          if (label) label.textContent = '展开全文';
        } else if (msg) {
          processedMessages.delete(msg);
          pendingMessages.add(msg);
          needsFlush = true;
        }
      }
    }

    if (needsFlush) scheduleFlush();
  }

  // ============================================================
  // 7. 启动 / 停止
  // ============================================================

  function resetState() {
    processedMessages = new WeakSet();
    handledThinkHeaders = new WeakSet();
    thinkResolvedMessages = new WeakSet();
    foldedContents = new WeakSet();
    messageIdentity = new WeakMap();
    pendingMessages.clear();
    composerEl = null;
    shareView = false;
  }

  function start() {
    if (enabled) {
      scheduleFlush();
      return;
    }
    enabled = true;
    resetState();

    const root = document.body || document.documentElement;
    if (root && root.classList) root.classList.add(ACTIVE_CLASS);

    if (!observer) {
      observer = new MutationObserver(handleMutations);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    // 首次收集只查一次消息容器，不做 span 全局遍历
    const messages = document.querySelectorAll(MSG_SELECTOR);
    messages.forEach(function (msg) {
      pendingMessages.add(msg);
    });

    ensureComposer();
    scheduleFlush();
  }

  function stop() {
    enabled = false;

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (document.body) document.body.classList.remove(ACTIVE_CLASS);

    document.querySelectorAll('.' + FOLD_CLASS).forEach(function (el) {
      el.classList.remove(FOLD_CLASS, EXPAND_CLASS);
    });
    document.querySelectorAll('.' + BTN_CLASS).forEach(function (el) {
      el.remove();
    });
    document.querySelectorAll('.' + COMPOSER_CLASS).forEach(function (el) {
      el.classList.remove(COMPOSER_CLASS);
    });

    resetState();
  }

  // ============================================================
  // 8. 与 popup 通信 + 初始化
  // ============================================================

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== 'DEEPTUCK_TOGGLE') return;
      if (message.enabled) {
        start();
      } else {
        stop();
      }
    });
  }

  function init() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ deeptuck_enabled: true }, function (result) {
        if (result && result.deeptuck_enabled) {
          start();
        } else {
          stop();
        }
      });
      return;
    }
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
