const toggleSwitch = document.getElementById('toggleSwitch');

// 初始化：从本地存储读取当前状态
chrome.storage.local.get({ deeptuck_enabled: true }, (result) => {
  toggleSwitch.checked = result.deeptuck_enabled;
});

// 监听用户点击开关
toggleSwitch.addEventListener('change', () => {
  const newState = toggleSwitch.checked;
  
  // 1. 保存到浏览器本地，下次打开依然是这个状态
  chrome.storage.local.set({ deeptuck_enabled: newState });
  
  // 2. 发送消息给当前活跃的网页标签
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      // 捕获异常，防止在非 DeepSeek 页面点击时报错
      chrome.tabs.sendMessage(tabs[0].id, { type: 'DEEPTUCK_TOGGLE', enabled: newState }).catch(err => {
        console.log("DeepTuck: 当前页面不是 DeepSeek 或尚未加载脚本。");
      });
    }
  });
});