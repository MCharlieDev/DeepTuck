### 一、 网页架构与列表特征
1. **虚拟列表容器**：
   * 根节点包含 `<div class="ds-virtual-list-items">`。
   * 内部有 `<div class="ds-virtual-list-visible-items" style="transform: translateY(XXXpx);">`。
2. **列表项标识**：
   * 每个消息组的最外层有一个 `<div data-virtual-list-item-key="XXX">` 属性（如 `key="14"`，`key="-14"`）。
   * 这证明 DOM 节点在滚动时会被动态销毁、复用或重新挂载。

### 二、 消息外层容器
1. **AI 回答容器**：
   * 外层包裹：`<div class="_4f9bf79 _43c05b5">`
   * 核心消息框：`<div class="ds-message _63c77b1" style="--panel-width: 0px;">`
2. **用户提问容器**：
   * 核心消息框：`<div class="d29f3d7d ds-message _63c77b1" style="--panel-width: 0px;">`
   * 文本内容区：`<div class="ds-collapsible-text" style="max-height: 192px; ...">`
3. **底部操作栏**（存在于 AI 消息的最底部）：
   * 容器：`<div class="ds-flex _0a3d93b" style="align-items: center; gap: 10px; flex-wrap: wrap-reverse;">`
   * 内部包含：复制、重新生成、点赞、点踩、朗读等按钮。

### 三、 思考过程（Think Block）结构
1. **触发点击的 Header 容器**：
   * `<div class="_245c867 _34a54ec">`
   * **事实**：该节点没有 `role="button"` 属性，也不是 `<button>` 标签。
   * **文本节点**：内部包含 `<span class="_5255ff8 _4d41763">已思考（用时 X 秒）</span>`。
2. **展开/折叠的图标特征**（位于 Header 容器末尾的 SVG）：
   * 展开状态（箭头朝下）：SVG 的 `path` 属性值为 `d="M11.8486 5.5..."`
   * 折叠状态（箭头朝右）：SVG 的 `path` 属性值为 `d="M5.5 2.15137..."`
3. **思考过程内容容器**（展开时存在）：
   * 外层：`<div class="e1675d8b ds-think-content _767406f">`
   * 内部正文：`<div class="ds-markdown">...</div>`

### 四、 正文（Markdown Content）结构
1. **主回答正文容器**：
   * `<div class="ds-markdown ds-assistant-message-main-content">`
   * **事实**：它与“思考过程内容容器”是完全平级的兄弟关系，且带有专属类名 `ds-assistant-message-main-content`。
2. **代码块结构**：
   * 容器：`<div class="md-code-block md-code-block-light">`
   * **事实**：代码块内部存在 `<div role="button" class="ds-button ...">`，其文本内容为“复制”、“下载”、“运行”。
3. **回答结束标志节点**（位于正文最末尾）：
   * `<div class="dbe8cf4a">本回答由 AI 生成，内容仅供参考，请仔细甄别</div>`

### 五、 输入框（Composer）结构
1. **输入框本体**：
   * `<textarea name="search" class="_27c9245 ds-scroll-area ds-scroll-area--show-on-focus-within ds-scroll-area--enabled d96f2d2a" ...>`
   * **行内样式事实**：`style="--container-height: 60px;"`
2. **输入框父级（带有动态 Hash 类名）**：
   * 第 1 层父级：`<div class="_24fad49">`
   * 第 2 层父级：`<div class="_020ab5b">`
   * 第 3 层父级：`<div class="_77cefa5 _3d616d3 _1d5e44c">`
3. **滚动条组件**：
   * 存在于输入框上方同级：`<div class="ds-scroll-area__gutters" style="--container-height: 60px; ...">`
   以下是针对**“创建分享链接选择界面”**（区别于普通聊天页和公开分享页），从截图和源码中提取的**纯客观事实线索**：

### 一、 界面专属结构（普通聊天页没有）
1. **左侧多选组件**：
   * 每条消息（包括用户提问和 AI 回答）的最左侧都包含复选框结构。
   * DOM 节点：`<div class="ds-checkbox-align-wrapper">` 包裹着 `<div class="ds-checkbox ds-checkbox--l ...">`。
   * 选中状态包含 `ds-checkbox--active`；未选中状态（或不可点状态）包含 `ds-checkbox--none`。
2. **底部固定操作栏**：
   * 页面底部有固定的操作区，包含“全选”、“已选择 X 组对话”、“取消”以及“创建分享链接”按钮。
3. **虚拟列表根节点差异**：
   * 此界面的虚拟列表最外层类名为：`<div class="ds-virtual-list ds-virtual-list--printable ...">`，比普通页面多了 `--printable`。

### 二、 消息容器与类名变化
1. **AI 消息外层**：
   * DOM 节点：`<div class="ds-message _6e8caf5 _7729a77" style="--panel-width: 1267px;">`。
   * 事实：哈希类名后缀（`_6e8caf5`）与普通聊天页（`_63c77b1`）完全不同。
2. **底部操作栏**：
   * DOM 节点：`<div class="ds-flex _0a3d93b fa1bcf13" ...>`，比普通页面多追加了一个随机哈希类名。

### 三、 正文与思考过程的交互状态
1. **只读限制**：
   * 在此界面下，主回答正文容器 `<div class="ds-markdown ds-assistant-message-main-content pointer-events-none">`。
   * 思考过程内容容器 `<div class="ds-markdown pointer-events-none">`。
   * 事实：两者都被强行注入了 `pointer-events-none` 类名，页面原生禁止了所有鼠标点击/悬停交互。
2. **思考块触发按钮**：
   * 容器：`<div class="_245c867 a51c5344">`（主干类名 `_245c867` 保留，后缀哈希变化）。

### 四、 输入框状态
1. **DOM 存在**：
   * 源码中依然存在 `<textarea name="search" class="_27c9245 ...">`，且带有 `style="--container-height: 60px;"`。
2. **UI 隐藏**：
   * 结合截图显示，底部的输入框组件在此选择界面下是不可见（隐藏）的。

### 五、 其他稳定元素（与普通页一致）
1. 思考块文本依然是：`<span class="_5255ff8 _4d41763">已思考（用时 X 秒）</span>`。
2. 代码块内依然存在 `<div role="button" class="ds-button ...">`。
3. 正文最末尾依然存在 `<div class="_0fcaa63">内容由 AI 生成，请仔细甄别</div>`（普通页可能是 `dbe8cf4a`，此处为 `_0fcaa63`）。