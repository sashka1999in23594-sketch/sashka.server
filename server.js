// Подключаем необходимые библиотеки
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Разрешаем подключения с любых сайтов (чтобы GitHub Pages мог связаться)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// PeerJS сервер для звонков (работает на том же порту)
const peerServer = ExpressPeerServer(server, {
  path: '/peerjs',
  allow_discovery: true
});
app.use('/peerjs', peerServer);

// Отдаём статические файлы из папки public (если будут)
app.use(express.static('public'));

// ---------- Хранилище (в памяти, сбрасывается при перезапуске) ----------
let users = [];
let chats = [];
let messages = {};

// Инициализация админа и системных чатов
function initData() {
  const adminPass = 'Master_302';
  const adminHash = crypto.createHash('sha256').update(adminPass).digest('hex');
  
  if (!users.find(u => u.name === 'sashka1999in2359')) {
    users.push({
      id: 'admin_0',
      name: 'sashka1999in2359',
      passwordHash: adminHash,
      avatar: null,
      description: 'Создатель мессенджера',
      blocked: false,
      isAdmin: true,
      online: false,
      allowDM: false
    });
  }
  
  if (!chats.find(c => c.id === 'system')) {
    chats.push({
      id: 'system',
      type: 'system',
      name: 'SashkaMessenger',
      avatar: null,
      members: [],
      description: 'Системные уведомления',
      creatorId: 'admin_0',
      bannedUsers: [],
      mutedUsers: [],
      adminIds: ['admin_0']
    });
    messages['system'] = [];
  }
  
  if (!chats.find(c => c.id === 'suggest')) {
    chats.push({
      id: 'suggest',
      type: 'suggest',
      name: 'Предложка SashkaMessenger',
      avatar: null,
      members: [],
      description: 'Ваши предложения',
      creatorId: 'admin_0'
    });
    messages['suggest'] = [];
  }
}
initData();

// ---------- Socket.IO обработчики ----------
io.on('connection', (socket) => {
  let currentUser = null;

  // Авторизация/регистрация
  socket.on('login', ({ name, password }, callback) => {
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    let user = users.find(u => u.name === name && u.passwordHash === hash);
    
    if (!user) {
      // Регистрация нового пользователя
      if (users.find(u => u.name === name)) {
        return callback({ error: 'Имя занято' });
      }
      user = {
        id: 'user_' + Date.now(),
        name,
        passwordHash: hash,
        avatar: null,
        description: '',
        blocked: false,
        isAdmin: false,
        online: true,
        allowDM: true
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
    io.emit('users_online', users.filter(u => u.online).length);
  });

  // Получить список чатов пользователя
  socket.on('get_chats', (callback) => {
    if (!currentUser) return callback([]);
    const myChats = chats.filter(c => 
      c.type === 'system' || c.type === 'suggest' || c.members.includes(currentUser.id)
    );
    callback(myChats);
  });

  // Получить сообщения конкретного чата
  socket.on('get_messages', (chatId, callback) => {
    if (!currentUser) return callback([]);
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return callback([]);
    let msgs = messages[chatId] || [];
    // В предложке обычные пользователи видят только свои сообщения
    if (chat.type === 'suggest' && !currentUser.isAdmin) {
      msgs = msgs.filter(m => m.fromId === currentUser.id || m.system);
    }
    callback(msgs);
  });

  // Отправить сообщение
  socket.on('send_message', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    const { chatId, text, file, fileType, fileName, videoBlob } = data;
    const chat = chats.find(c => c.id === chatId);
    
    if (!chat) return callback({ error: 'Чат не найден' });
    if (chat.bannedUsers?.includes(currentUser.id)) return callback({ error: 'Забанены' });
    if (chat.type === 'channel' && !chat.adminIds?.includes(currentUser.id)) return callback({ error: 'Нельзя писать' });
    if (chat.type === 'system' && !currentUser.isAdmin) return callback({ error: 'Только админ' });
    
    const msg = {
      id: 'msg_' + Date.now(),
      from: currentUser.name,
      fromId: currentUser.id,
      text: text || '',
      file: file || null,
      fileType: fileType || null,
      fileName: fileName || null,
      videoBlob: videoBlob || null,
      time: Date.now(),
      system: false,
      anonymous: chat.type === 'channel'
    };
    
    if (!messages[chatId]) messages[chatId] = [];
    messages[chatId].push(msg);
    
    // Автоответ в предложке
    if (chat.type === 'suggest' && text) {
      const autoMsg = {
        id: 'msg_' + Date.now() + 1,
        from: 'SashkaMessenger',
        fromId: 'system',
        text: 'Спасибо за предложение! Вместе мы сделаем сервис лучше!',
        time: Date.now(),
        system: true
      };
      messages[chatId].push(autoMsg);
    }
    
    // Рассылаем сообщение всем в чате (включая отправителя для синхронизации)
    io.to(chatId).emit('new_message', { chatId, msg });
    callback({ success: true });
  });

  // Присоединиться к комнате чата
  socket.on('join_chat', (chatId) => {
    if (!currentUser) return;
    const chat = chats.find(c => c.id === chatId);
    if (chat && (chat.members.includes(currentUser.id) || chat.type === 'system' || chat.type === 'suggest')) {
      socket.join(chatId);
    }
  });

  // Создание чата
  socket.on('create_chat', (data, callback) => {
    if (!currentUser) return callback({ error: 'Не авторизован' });
    // Реализация создания чатов (private, group, channel) – оставим упрощённо
    callback({ error: 'Пока не реализовано, используйте интерфейс' });
  });

  // Отключение пользователя
  socket.on('disconnect', () => {
    if (currentUser) {
      currentUser.online = false;
      io.emit('users_online', users.filter(u => u.online).length);
    }
  });
});

// Запуск сервера на порту 3000 (Render автоматически назначит порт)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
