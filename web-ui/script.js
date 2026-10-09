const sendBtn = document.getElementById('send-btn');
const userInput = document.getElementById('user-input');
const chatBox = document.getElementById('chat-box');

sendBtn.addEventListener('click', () => {
    const text = userInput.value.trim();
    if (!text) return;

     // 显示用户消息
    addMessage(text, 'user-message');
    userInput.value = '';

    // 后续这里要替换成真实的后端接口调用
    setTimeout(() => {
        addMessage("我收到了你的消息：" + text, 'ai-message');
    }, 800);
});

function addMessage(text, className) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ' + className;
    msgDiv.textContent = text;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight; 
}