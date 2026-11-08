/* DeepTuck v1.0.1 · content.js
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
  const TEXTAREA_SELECTOR = 'textarea[name="search"]';

  // 思考标题容器的已知动态类名；未命中时退回最近的 div 祖先
  const THINK_HEADER_CLASSES = '._245c867, ._34a54ec';

  const THINK_OPEN_CLASS = 'deeptuck-think-open';
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
  let thinkOpenMessages = new WeakSet();      // 用户手动展开过思考块的消息（用于恢复类名）
  let foldedContents = new WeakSet();         // 曾被我们折叠过的正文（用于类名被 React 重置后恢复）
  let messageIdentity = new WeakMap();        // .ds-message -> 虚拟列表 key（识别节点复用）

  // 仍在流式输出、需要复查的消息（通常只有 0~2 个）
  const pendingMessages = new Set();

  let enabled = false;
  let observer = null;
  let rafId = 0;
  let composerEl = null;

  // ============================================================
  // 工具函数
  // ============================================================

  /** 读取虚拟列表 key，用于识别节点是否被复用 */
  function readVirtualKey(msg) {
    const item = msg.closest('[data-virtual-list-item-key]');
    return item ? item.getAttribute('data-virtual-list-item-key') : null;
  }

  /** 找到真正负责纵向滚动的祖先容器 */
  function getScrollParent(el) {
    let node = el ? el.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
        node.scrollHeight > node.clientHeight
      ) {
        return node;
      }
      node = node.parentElement;
    }
    const docEl = document.scrollingElement || document.documentElement;
    return docEl && docEl.scrollHeight > docEl.clientHeight ? docEl : null;
  }

  /** 取滚动容器中当前视口最靠上的消息项作为视口锚点 */
  function pickViewportAnchor(scroller) {
    if (!scroller) return null;
    const viewport = scroller.getBoundingClientRect();
    const container = scroller.querySelector('.ds-virtual-list-visible-items') || scroller;

    // 优先取“顶部刚好落在视口内或下方”的第一项，避免锚到已经滚出视口上方的长消息
    const items = container.querySelectorAll('[data-virtual-list-item-key]');
    let anchor = pickFromElements(items, viewport);
    if (anchor) return anchor;

    return pickFromElements(container.querySelectorAll(MSG_SELECTOR), viewport);
  }

  function pickFromElements(elements, viewport) {
    let atOrBelow = null;
    let atOrBelowTop = Infinity;
    let intersecting = null;
    let intersectingTop = Infinity;

    for (let i = 0; i < elements.length; i++) {
      const rect = elements[i].getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.bottom <= viewport.top + 1 || rect.top >= viewport.bottom - 1) continue;

      if (rect.top < intersectingTop) {
        intersectingTop = rect.top;
        intersecting = elements[i];
      }
      if (rect.top >= viewport.top - 1 && rect.top < atOrBelowTop) {
        atOrBelowTop = rect.top;
        atOrBelow = elements[i];
      }
    }
    return atOrBelow || intersecting;
  }

  /** 折叠/展开前记录当前视口锚点，避免列表高度变化把用户窗口顶飞 */
  function captureScrollSnapshot(fallbackEl) {
    const scroller = getScrollParent(fallbackEl);
    if (!scroller) return null;
    const anchor = pickViewportAnchor(scroller) || fallbackEl;
    if (!anchor || !anchor.isConnected) return null;
    return {
      scroller: scroller,
      anchor: anchor,
      top: anchor.getBoundingClientRect().top,
    };
  }

  /** 布局变化后把锚点拉回原来的视口位置；下一帧再校正一次，兼容虚拟列表重算 */
  function restoreScrollSnapshot(snapshot, deferred) {
    if (!snapshot) return;
    const scroller = snapshot.scroller;
    const anchor = snapshot.anchor;
    if (!scroller || !scroller.isConnected || !anchor || !anchor.isConnected) return;

    const currentTop = anchor.getBoundingClientRect().top;
    const delta = currentTop - snapshot.top;
    if (Math.abs(delta) >= 1) {
      scroller.scrollTop += delta;
    }

    if (!deferred) {
      requestAnimationFrame(function () {
        restoreScrollSnapshot(snapshot, true);
      });
    }
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
  // 思考内容由 CSS 在挂载时直接隐藏，这里只负责原生标题的展开/收起
  // ============================================================

  function handleThinkHeaderClick(event) {
    if (!enabled) return;
    const target = event.target;
    if (!target || !target.closest) return;

    const header = target.closest(THINK_HEADER_CLASSES);
    if (!header) return;
    const msg = header.closest(MSG_SELECTOR);
    if (!msg) return;

    const thinkContent = msg.querySelector(THINK_CONTENT_SELECTOR);

    // 站点自身处于折叠态（内容不存在）：让它按原生逻辑展开，下一帧再接管显示
    if (!thinkContent) {
      const snapshot = captureScrollSnapshot(msg);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!msg.isConnected) return;
          if (msg.querySelector(THINK_CONTENT_SELECTOR)) {
            msg.classList.add(THINK_OPEN_CLASS);
            thinkOpenMessages.add(msg);
            repositionFoldButtonInMessage(msg);
          }
          restoreScrollSnapshot(snapshot, true);
        });
      });
      return;
    }

    // 站点默认是展开态：拦截原生点击，改为由我们的类名控制显示
    event.preventDefault();
    event.stopPropagation();

    const snapshot = captureScrollSnapshot(msg);
    const open = msg.classList.toggle(THINK_OPEN_CLASS);
    if (open) thinkOpenMessages.add(msg);
    else thinkOpenMessages.delete(msg);
    repositionFoldButtonInMessage(msg);
    restoreScrollSnapshot(snapshot);
  }

  // ============================================================
  // 2. 正文折叠
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

  /** 按正文位置把绝对定位按钮放到正文底部（不参与布局） */
  function positionFoldButton(content, btn, host) {
    if (!content || !btn || !host || !content.isConnected) return;
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    const hostRect = host.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    btn.style.position = 'absolute';
    btn.style.left =
      Math.max(0, Math.round(contentRect.left - hostRect.left - host.clientLeft)) + 'px';
    btn.style.top =
      Math.max(0, Math.round(contentRect.bottom - hostRect.top - host.clientTop - 28)) + 'px';
  }

  function repositionFoldButtonInMessage(msg) {
    if (!msg) return;
    const content = msg.querySelector(MAIN_CONTENT_SELECTOR);
    const btn = msg.querySelector('.' + BTN_CLASS);
    if (content && btn) positionFoldButton(content, btn, msg);
  }

  function repositionAllFoldButtons() {
    document.querySelectorAll(MSG_SELECTOR).forEach(function (msg) {
      repositionFoldButtonInMessage(msg);
    });
  }

  /** 按钮追加到消息末尾并用绝对定位覆盖在正文底部，不改变 item 高度 */
  function insertFoldButton(content, btn) {
    const host = content.closest(MSG_SELECTOR) || content.parentElement;
    if (!host) {
      content.insertAdjacentElement('afterend', btn);
      return;
    }
    host.appendChild(btn);
    positionFoldButton(content, btn, host);
  }

  function foldContent(content) {
    if (!content) return;

    const host = content.closest(MSG_SELECTOR);
    const next = content.nextElementSibling;
    const existingBtn =
      (host && host.querySelector('.' + BTN_CLASS)) ||
      (next && next.classList && next.classList.contains(BTN_CLASS));

    // 类名和按钮都在，才是完整折叠态
    if (existingBtn && content.classList.contains(FOLD_CLASS)) {
      if (host) repositionFoldButtonInMessage(host);
      return;
    }

    // 高度即将变化，先锁定当前视口锚点
    const snapshot = captureScrollSnapshot(content);

    content.classList.add(FOLD_CLASS);
    foldedContents.add(content);

    // 类名还在、只是按钮被抹掉了：只补按钮，不动用户展开状态
    if (existingBtn) {
      if (host) repositionFoldButtonInMessage(host);
      restoreScrollSnapshot(snapshot);
      return;
    }
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
    restoreScrollSnapshot(snapshot);
  }

  function toggleFold(content, btn) {
    if (!content.isConnected || !btn.isConnected) return;

    const snapshot = captureScrollSnapshot(content);
    const expanded = content.classList.toggle(EXPAND_CLASS);
    const label = btn.querySelector('.' + BTN_TEXT_CLASS);
    if (label) label.textContent = expanded ? '收起' : '展开全文';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    repositionFoldButtonInMessage(content.closest(MSG_SELECTOR));
    restoreScrollSnapshot(snapshot);
  }

  // ============================================================
  // 3. 单条消息处理（返回 true 表示本轮已处理完毕）
  // ============================================================

  function processMessage(msg) {
    if (!enabled || !msg || !msg.isConnected) return true;

    const key = readVirtualKey(msg);

    if (processedMessages.has(msg)) {
      // 身份未变且注入产物仍在：已处理完毕
      if (messageIdentity.get(msg) === key && !artifactsLost(msg)) return true;
      // 节点被虚拟列表复用，或 React 重渲染抹掉了类名/按钮：清理后重新处理
      processedMessages.delete(msg);
      clearArtifacts(msg);
    }
    messageIdentity.set(msg, key);

    // B 方案：正文已在 CSS 层挂载即限高，这里只补渐隐与按钮，不再等免责声明
    processedMessages.add(msg);

    const content = msg.querySelector(MAIN_CONTENT_SELECTOR);
    if (!content) return true;
    // 类名和按钮都在：只校正按钮位置
    if (content.classList.contains(FOLD_CLASS) && msg.querySelector('.' + BTN_CLASS)) {
      repositionFoldButtonInMessage(msg);
      return true;
    }

    const height = content.scrollHeight || 0;
    if (height > MAX_CONTENT_HEIGHT) {
      foldContent(content);
    }
    return true;
  }

  // ============================================================
  // 4. 输入框标记（只打类名，高度交给 CSS，不找父节点）
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
  // 5. 观察与调度
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
        // 节点被移除（例如 React 抹掉我们的按钮）时也要重新检查所属消息
        const target = mutation.target;
        if (target && target.nodeType === 1 && target.closest) {
          const owner = target.closest(MSG_SELECTOR);
          if (owner) pendingMessages.add(owner);
        }
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

        // React 重置消息类名时，恢复用户手动展开的思考块状态
        if (target.matches && target.matches(MSG_SELECTOR)) {
          if (thinkOpenMessages.has(target) && !target.classList.contains(THINK_OPEN_CLASS)) {
            target.classList.add(THINK_OPEN_CLASS);
            repositionFoldButtonInMessage(target);
          }
          continue;
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
  // 6. 启动 / 停止
  // ============================================================

  function resetState() {
    processedMessages = new WeakSet();
    thinkOpenMessages = new WeakSet();
    foldedContents = new WeakSet();
    messageIdentity = new WeakMap();
    pendingMessages.clear();
    composerEl = null;
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

    // 关闭插件会一次性展开所有内容，先锁住当前视口
    const anyContent = document.querySelector(MAIN_CONTENT_SELECTOR);
    const snapshot = anyContent ? captureScrollSnapshot(anyContent) : null;

    if (document.body) document.body.classList.remove(ACTIVE_CLASS);
    document.querySelectorAll('.' + THINK_OPEN_CLASS).forEach(function (el) {
      el.classList.remove(THINK_OPEN_CLASS);
    });

    document.querySelectorAll('.' + FOLD_CLASS).forEach(function (el) {
      el.classList.remove(FOLD_CLASS, EXPAND_CLASS);
    });
    document.querySelectorAll('.' + BTN_CLASS).forEach(function (el) {
      el.remove();
    });
    document.querySelectorAll('.' + COMPOSER_CLASS).forEach(function (el) {
      el.classList.remove(COMPOSER_CLASS);
    });

    restoreScrollSnapshot(snapshot);
    resetState();
  }

  // ============================================================
  // 7. 与 popup 通信 + 初始化
  // ============================================================

  // 拦截原生“已思考”标题点击，由我们的类名控制展开/收起
  window.addEventListener('click', handleThinkHeaderClick, true);
  window.addEventListener('resize', repositionAllFoldButtons);

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
