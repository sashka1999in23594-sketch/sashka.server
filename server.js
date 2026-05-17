const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const peerServer = ExpressPeerServer(server, {
  path: '/peerjs',
  allow_discovery: true
});
app.use('/peerjs', peerServer);
app.use(express.static('public'));

// ---------- Хранилище ----------
let users = [];
let chats = [];
let messages = {};

function initData() {
  const adminPass = 'Master_302';
  const adminHash = crypto.createHash('sha256').update(adminPass).digest('hex');
  
  if (!users.find(u => u.name === 'sashka1999in2359')) {
    users.push({
      id: 'admin_0', name: 'sashka1999in2359', passwordHash: adminHash,
      avatar: null, description: 'Создатель мессенджера', blocked: false,
      isAdmin: true, online: false, allowDM: false
    });
  }
  
  if (!chats.find(c => c.id === 'system')) {
    chats.push({
      id: 'system', type: 'system', name: 'SashkaMessenger',
      avatar: null, members: [], description: 'Системные уведомления',
      creatorId: 'admin_0', bannedUsers: [], mutedUsers: [],
      adminIds: ['admin_0'], deleted: false, deletionTime: null,
      successorId: null, passwordHash: null
    });
    messages['system'] = [];
  }
  
  if (!chats.find(c => c.id === 'suggest')) {
    chats.push({
      id: 'suggest', type: 'suggest', name: 'Предложка SashkaMessenger',
      avatar: null, members: [], description: 'Ваши предложения',
      creatorId: 'admin_0', bannedUsers: [], mutedUsers: [],
      adminIds: ['admin_0'], deleted: false
    });
    messages['suggest'] = [];
  }
}
initData();

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('login', ({ name, password, description }, callback) => {
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    let user = users.find(u => u.name === name && u.passwordHash === hash);
    
    if (!user) {
      if (users.find(u => u.name === name)) {
        return callback({ error: 'Имя занято' });
      }
      user = {
        id: 'user_' + Date.now(), name, passwordHash: hash,
        avatar: null, description: description || '', blocked: false,
        isAdmin: false, online: true, allowDM: true
      };
      users.push(user);
    } else {
      if (user.blocked) return callback({ error: 'Аккаунт заблокирован' });
      user.online = true;
    }
    
    currentUser = user;
    socket.userId = user.id;
    socket.join('user_' + user.id);
    
    callback({ success: true, user: { ...user, passwordHash: undefined } });
  });

  socket.on('get_chats', (callback) => {
    if (!currentUser) return callback([]);
    const myChats = chats.filter(c => 
      c.type === 'system' || c.type === 'suggest' || 
      (c.members && c.members.includes(currentUser.id))
    );
    callback(myChats);
  });

  socket.on('get_users', (callback) => {
    callback(users.map(u => ({ ...u, passwordHash: undefined })));
  });

  socket.on('get_messages', (chatId, callback) => {
    if (!currentUser) return callback([]);
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return callback([]);
    let msgs = messages[chatId] || [];
    if (chat.type === 'suggest' && !currentUser.isAdmin) {
      msgs = msgs.filter(m => m.fromId === currentUser.id || m.system);
    }
    callback(msgs);
  });

  socket.on('get_all_messages', (callback) => {
    callback(messages);
  });

  // ========== ОТПРАВКА СООБЩЕНИЙ (РАБОТАЕТ!) ==========
  socket.on('send_message', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    
    const chatId = data.chatId;
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return callback({ error: 'Чат не найден' });
    if (chat.bannedUsers?.includes(currentUser.id)) return callback({ error: 'Забанены' });
    
    const msg = {
      id: data.msg?.id || 'msg_' + Date.now(),
      from: currentUser.name,
      fromId: currentUser.id,
      text: data.text || data.msg?.text || '',
      file: data.file || data.msg?.file || null,
      fileType: data.fileType || data.msg?.fileType || null,
      fileName: data.fileName || data.msg?.fileName || null,
      videoBlob: data.videoBlob || data.msg?.videoBlob || null,
      time: Date.now(),
      system: false,
      anonymous: chat.type === 'channel'
    };
    
    if (!messages[chatId]) messages[chatId] = [];
    messages[chatId].push(msg);
    
    // Автоответ в предложке
    if (chat.type === 'suggest' && (msg.text || data.text)) {
      const autoMsg = {
        id: 'msg_' + Date.now() + 1,
        from: 'SashkaMessenger', fromId: 'system',
        text: 'Спасибо за предложение! Вместе мы сделаем сервис лучше!',
        time: Date.now(), system: true
      };
      messages[chatId].push(autoMsg);
      io.to(chatId).emit('new_message', { chatId, msg: autoMsg });
    }
    
    io.to(chatId).emit('new_message', { chatId, msg });
    callback({ success: true });
  });

  socket.on('join_chat', (chatId) => {
    if (!currentUser) return;
    const chat = chats.find(c => c.id === chatId);
    if (chat && (chat.type === 'system' || chat.type === 'suggest' || 
        (chat.members && chat.members.includes(currentUser.id)))) {
      socket.join(chatId);
    }
  });

  // ========== СОЗДАНИЕ ЧАТОВ (РАБОТАЕТ!) ==========
  socket.on('create_chat', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    
    try {
      if (data.type === 'private') {
        const target = users.find(u => u.name === data.targetName);
        if (!target) return callback({ error: 'Пользователь не найден' });
        if (target.id === currentUser.id) return callback({ error: 'Нельзя с собой' });
        
        const existChat = chats.find(c => 
          c.type === 'private' && 
          c.members.includes(currentUser.id) && 
          c.members.includes(target.id)
        );
        if (existChat) return callback({ success: true, chatId: existChat.id });
        
        const chatId = 'priv_' + [currentUser.id, target.id].sort().join('_');
        chats.push({
          id: chatId, type: 'private', name: null,
          members: [currentUser.id, target.id], avatar: null,
          creatorId: null, bannedUsers: [], mutedUsers: [],
          adminIds: [], deleted: false, description: ''
        });
        messages[chatId] = [];
        callback({ success: true, chatId });
        
      } else if (data.type === 'group') {
        if (!data.name) return callback({ error: 'Название обязательно' });
        if (!data.password) return callback({ error: 'Пароль обязателен' });
        
        const passHash = crypto.createHash('sha256').update(data.password).digest('hex');
        const existGroup = chats.find(c => 
          c.type === 'group' && c.name === data.name && c.passwordHash === passHash
        );
        if (existGroup) return callback({ error: 'Группа с таким именем и паролем уже есть' });
        
        const chatId = 'group_' + Date.now();
        const members = [currentUser.id];
        if (data.members) {
          data.members.split(',').forEach(name => {
            const u = users.find(u => u.name === name.trim() && u.id !== currentUser.id);
            if (u && !members.includes(u.id)) members.push(u.id);
          });
        }
        
        chats.push({
          id: chatId, type: 'group', name: data.name,
          passwordHash: passHash, members, avatar: null,
          description: data.desc || '', creatorId: currentUser.id,
          bannedUsers: [], mutedUsers: [], adminIds: [currentUser.id],
          deleted: false, deletionTime: null, successorId: null
        });
        messages[chatId] = [];
        callback({ success: true, chatId });
        
      } else if (data.type === 'channel') {
        if (!data.name) return callback({ error: 'Название обязательно' });
        
        const chatId = 'channel_' + Date.now();
        const members = [currentUser.id];
        if (data.members) {
          data.members.split(',').forEach(name => {
            const u = users.find(u => u.name === name.trim() && u.id !== currentUser.id);
            if (u && !members.includes(u.id)) members.push(u.id);
          });
        }
        
        chats.push({
          id: chatId, type: 'channel', name: data.name,
          members, avatar: null, description: data.desc || '',
          creatorId: currentUser.id, bannedUsers: [], mutedUsers: [],
          adminIds: [currentUser.id], deleted: false
        });
        messages[chatId] = [];
        callback({ success: true, chatId });
      }
    } catch (e) {
      callback({ error: e.message });
    }
  });

  socket.on('join_group', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    const chat = chats.find(c => c.id === data.chatId && c.type === 'group');
    if (!chat) return callback({ error: 'Группа не найдена' });
    
    const passHash = crypto.createHash('sha256').update(data.password).digest('hex');
    if (chat.passwordHash !== passHash) return callback({ error: 'Неверный пароль' });
    
    if (!chat.members.includes(currentUser.id)) {
      chat.members.push(currentUser.id);
    }
    callback({ success: true });
  });

  socket.on('join_channel', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    const chat = chats.find(c => c.id === data.chatId && c.type === 'channel');
    if (!chat) return callback({ error: 'Канал не найден' });
    
    if (!chat.members.includes(currentUser.id)) {
      chat.members.push(currentUser.id);
    }
    callback({ success: true });
  });

  socket.on('toggle_block', (data) => {
    if (!currentUser?.isAdmin) return;
    const user = users.find(u => u.id === data.userId);
    if (user && !user.isAdmin) {
      user.blocked = !user.blocked;
    }
  });

  socket.on('broadcast', (data) => {
    if (!currentUser?.isAdmin) return;
    if (!messages['system']) messages['system'] = [];
    messages['system'].push({
      id: 'msg_' + Date.now(),
      from: 'SashkaMessenger', fromId: 'system',
      text: data.text, time: Date.now(), system: true
    });
    io.to('system').emit('new_message', {
      chatId: 'system',
      msg: messages['system'][messages['system'].length - 1]
    });
  });

  socket.on('update_profile', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    if (data.description !== undefined) currentUser.description = data.description;
    if (data.password) {
      currentUser.passwordHash = crypto.createHash('sha256').update(data.password).digest('hex');
    }
    const user = users.find(u => u.id === currentUser.id);
    if (user) {
      user.description = currentUser.description;
      user.passwordHash = currentUser.passwordHash;
    }
    callback({ success: true, user: { ...currentUser, passwordHash: undefined } });
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      currentUser.online = false;
      const user = users.find(u => u.id === currentUser.id);
      if (user) user.online = false;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
