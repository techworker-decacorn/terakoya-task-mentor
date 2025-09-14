const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const moment = require('moment-timezone');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// メモリ内データベース（本番では外部DBを使用）
const users = new Map();
const tasks = new Map();
const weeklyReports = new Map();
const userStates = new Map(); // ユーザーの状態管理

// デフォルト設定
const DEFAULT_SETTINGS = {
  amTime: '07:30',
  pmTime: '21:30',
  weeklyTime: '19:00',
  weeklyDay: 'Sun',
  deadline: '23:00',
  timezone: 'Asia/Tokyo',
  tone: 'mild'
};

// 署名検証関数
function verifySignature(signature, body, secret) {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');
  
  return signature === hash;
}

// ユーザー初期化
function initializeUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      settings: { ...DEFAULT_SETTINGS },
      currentTasks: [],
      currentWeek: moment().tz(DEFAULT_SETTINGS.timezone).format('YYYY-WW'),
      lastAmReport: null,
      lastPmReport: null,
      weeklyStats: {
        totalTasks: 0,
        completedTasks: 0,
        missedTasks: 0,
        alignment: 0.5
      }
    });
  }
  return users.get(userId);
}

// ユーザー状態管理
function setUserState(userId, state) {
  userStates.set(userId, state);
}

function getUserState(userId) {
  return userStates.get(userId) || 'normal';
}

function clearUserState(userId) {
  userStates.delete(userId);
}

// トーン別メッセージ生成
function getToneMessage(tone, type, data = {}) {
  const messages = {
    mild: {
      morning: 'おはようございます！今日の3つのタスクを教えてください。\n\n例: am: タスクA, タスクB, タスクC',
      evening: 'お疲れ様でした！今日の結果はいかがでしたか？\n\n例: pm: A=done, B=done, C=miss(理由)',
      weekly: `今週の振り返りです！\n\n達成率: ${data.completionRate}%\nアラインメント: ${data.alignment}\n\n来週も頑張りましょう！`,
      help: 'コマンド一覧:\n• am: タスクA, タスクB, タスクC\n• pm: A=done, B=done, C=miss(理由)\n• /tone mild|sharp|dos\n• /time am HH:MM\n• /time pm HH:MM\n• /time weekly <曜日> HH:MM\n• /deadline HH:MM\n• /tz <IANA>\n• /help'
    },
    sharp: {
      morning: '朝だ。今日の3つは？\n\nam: タスクA, タスクB, タスクC',
      evening: '結果は？\n\npm: A=done, B=done, C=miss(理由)',
      weekly: `今週の実績\n\n達成率: ${data.completionRate}%\nアラインメント: ${data.alignment}\n\n来週は改善が必要だ。`,
      help: 'コマンド:\nam: タスク宣言\npm: 結果報告\n/tone: トーン変更\n/time: 時刻設定\n/deadline: 締切設定\n/tz: タイムゾーン\n/help: ヘルプ'
    },
    dos: {
      morning: '起きろ。今日の3つを決めろ。\n\nam: タスクA, タスクB, タスクC',
      evening: '報告しろ。\n\npm: A=done, B=done, C=miss(理由)',
      weekly: `今週の結果\n\n達成率: ${data.completionRate}%\nアラインメント: ${data.alignment}\n\n来週は必ず改善せよ。`,
      help: 'コマンド一覧:\nam: タスク宣言\npm: 結果報告\n/tone: トーン変更\n/time: 時刻設定\n/deadline: 締切設定\n/tz: タイムゾーン\n/help: ヘルプ'
    }
  };
  
  return messages[tone]?.[type] || messages.mild[type];
}

// 朝コミット処理
function handleMorningCommit(userId, message) {
  const user = initializeUser(userId);
  const tasks = message.replace(/^am:\s*/i, '').split(',').map(t => t.trim()).filter(t => t);
  
  if (tasks.length === 0 || tasks.length > 3) {
    return 'タスクは1〜3個で入力してください。\n\n例: am: タスクA, タスクB, タスクC';
  }
  
  user.currentTasks = tasks.map((task, index) => ({
    id: `${index + 1}`,
    name: task,
    status: 'pending',
    reason: null
  }));
  user.lastAmReport = moment().tz(user.settings.timezone).format();
  
  return `了解しました。今日のタスクを記録しました。\n\n${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n夜に結果を報告してください。`;
}

// 夜レポート処理
function handleEveningReport(userId, message) {
  const user = initializeUser(userId);
  
  if (user.currentTasks.length === 0) {
    return 'まず朝にタスクを宣言してください。\n\n例: am: タスクA, タスクB, タスクC';
  }
  
  const reportPattern = /^pm:\s*(.+)$/i;
  const match = message.match(reportPattern);
  
  if (!match) {
    return '正しい形式で報告してください。\n\n例: pm: A=done, B=done, C=miss(理由)';
  }
  
  const reports = match[1].split(',').map(r => r.trim());
  const results = {};
  
  for (const report of reports) {
    const taskMatch = report.match(/^([ABC])\s*=\s*(done|miss)(?:\s*\((.+)\))?$/i);
    if (taskMatch) {
      const [, taskId, status, reason] = taskMatch;
      results[taskId.toUpperCase()] = { status, reason };
    }
  }
  
  // タスクの結果を更新
  user.currentTasks.forEach(task => {
    const taskId = String.fromCharCode(64 + parseInt(task.id)); // A, B, C
    if (results[taskId]) {
      task.status = results[taskId].status;
      task.reason = results[taskId].reason;
    }
  });
  
  user.lastPmReport = moment().tz(user.settings.timezone).format();
  
  // 週次統計を更新
  user.weeklyStats.totalTasks += user.currentTasks.length;
  user.weeklyStats.completedTasks += user.currentTasks.filter(t => t.status === 'done').length;
  user.weeklyStats.missedTasks += user.currentTasks.filter(t => t.status === 'miss').length;
  
  const completed = user.currentTasks.filter(t => t.status === 'done').length;
  const total = user.currentTasks.length;
  
  return `報告を受け付けました。\n\n完了: ${completed}/${total}タスク\n\nお疲れ様でした！`;
}

// 週次レビュー生成
function generateWeeklyReview(userId) {
  const user = initializeUser(userId);
  const stats = user.weeklyStats;
  
  const completionRate = stats.totalTasks > 0 ? Math.round((stats.completedTasks / stats.totalTasks) * 100) : 0;
  const alignment = stats.alignment;
  
  // 週次統計をリセット
  user.weeklyStats = {
    totalTasks: 0,
    completedTasks: 0,
    missedTasks: 0,
    alignment: 0.5
  };
  user.currentTasks = [];
  
  return getToneMessage(user.settings.tone, 'weekly', {
    completionRate,
    alignment
  });
}

// 設定メニュー表示
function showSettingsMenu(userId) {
  const user = initializeUser(userId);
  return {
    type: 'text',
    text: '設定メニューを開きました。変更したい項目を選んでください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '朝の時間を設定',
            data: 'open:am'
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '夜の時間を設定',
            data: 'open:pm'
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '週次レビュー時間',
            data: 'open:weekly'
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '口調（トーン）',
            data: 'open:tone'
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '締切時刻',
            data: 'open:deadline'
          }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'タイムゾーン',
            data: 'open:tz'
          }
        }
      ]
    }
  };
}

// コマンド処理
function handleCommand(userId, command) {
  const user = initializeUser(userId);
  const parts = command.split(' ');
  
  switch (parts[0]) {
    case '/tone':
      if (['mild', 'sharp', 'dos'].includes(parts[1])) {
        user.settings.tone = parts[1];
        clearUserState(userId);
        return `トーンを${parts[1]}に変更しました。`;
      }
      return '使用可能なトーン: mild, sharp, dos';
      
    case '/time':
      if (parts[1] === 'am' && parts[2]) {
        user.settings.amTime = parts[2];
        clearUserState(userId);
        return `朝の通知時刻を${parts[2]}に設定しました。`;
      } else if (parts[1] === 'pm' && parts[2]) {
        user.settings.pmTime = parts[2];
        clearUserState(userId);
        return `夜の通知時刻を${parts[2]}に設定しました。`;
      } else if (parts[1] === 'weekly' && parts[2] && parts[3]) {
        user.settings.weeklyDay = parts[2];
        user.settings.weeklyTime = parts[3];
        clearUserState(userId);
        return `週次レビューを${parts[2]} ${parts[3]}に設定しました。`;
      }
      return '使用例: /time am 07:30, /time pm 21:30, /time weekly Sun 19:00';
      
    case '/deadline':
      if (parts[1]) {
        user.settings.deadline = parts[1];
        clearUserState(userId);
        return `締切時刻を${parts[1]}に設定しました。`;
      }
      return '使用例: /deadline 23:30';
      
    case '/tz':
      if (parts[1]) {
        user.settings.timezone = parts[1];
        clearUserState(userId);
        return `タイムゾーンを${parts[1]}に設定しました。`;
      }
      return '使用例: /tz Asia/Tokyo';
      
    case '/help':
      return getToneMessage(user.settings.tone, 'help');
      
    case '/settings':
      return showSettingsMenu(userId);
      
    default:
      return '不明なコマンドです。 /help でコマンド一覧を確認してください。';
  }
}

// Quick Reply生成
function getQuickReplyItems() {
  return [
    {
      type: 'action',
      action: {
        type: 'message',
        label: 'am',
        text: 'am: '
      }
    },
    {
      type: 'action',
      action: {
        type: 'message',
        label: 'pm',
        text: 'pm: '
      }
    },
    {
      type: 'action',
      action: {
        type: 'message',
        label: '設定',
        text: '/settings'
      }
    }
  ];
}

// メッセージ送信
async function sendMessage(userId, text, useQuickReply = false) {
  try {
    const message = {
      to: userId,
      messages: [{
        type: 'text',
        text: text
      }]
    };
    
    if (useQuickReply) {
      message.messages[0].quickReply = {
        items: getQuickReplyItems()
      };
    }
    
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      console.error('メッセージ送信エラー:', response.status, response.statusText);
    } else {
      console.log('メッセージを送信しました');
    }
  } catch (error) {
    console.error('メッセージ送信エラー:', error);
  }
}

// リプライメッセージ送信
async function sendReplyMessage(replyToken, text, useQuickReply = false, customQuickReply = null) {
  try {
    const message = {
      replyToken: replyToken,
      messages: [{
        type: 'text',
        text: text
      }]
    };
    
    if (useQuickReply && customQuickReply) {
      message.messages[0].quickReply = customQuickReply;
    } else if (useQuickReply) {
      message.messages[0].quickReply = {
        items: getQuickReplyItems()
      };
    }
    
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      console.error('リプライメッセージ送信エラー:', response.status, response.statusText);
    } else {
      console.log('リプライメッセージを送信しました');
    }
  } catch (error) {
    console.error('リプライメッセージ送信エラー:', error);
  }
}

// 定期通知処理
function scheduleNotifications() {
  // 毎分実行して時刻をチェック
  cron.schedule('* * * * *', () => {
    const now = moment();
    
    users.forEach((user, userId) => {
      const userTime = now.tz(user.settings.timezone);
      const timeStr = userTime.format('HH:mm');
      const dayOfWeek = userTime.format('ddd');
      
      // 朝の通知
      if (timeStr === user.settings.amTime && !user.lastAmReport) {
        const message = getToneMessage(user.settings.tone, 'morning');
        sendMessage(userId, message, true);
      }
      
      // 夜の通知
      if (timeStr === user.settings.pmTime && user.lastAmReport && !user.lastPmReport) {
        const message = getToneMessage(user.settings.tone, 'evening');
        sendMessage(userId, message, true);
      }
      
      // 週次レビュー
      if (dayOfWeek === user.settings.weeklyDay && timeStr === user.settings.weeklyTime) {
        const review = generateWeeklyReview(userId);
        sendMessage(userId, review);
      }
      
      // 締切チェック（未報告の場合はmissに設定）
      if (timeStr === user.settings.deadline && user.lastAmReport && !user.lastPmReport) {
        user.currentTasks.forEach(task => {
          if (task.status === 'pending') {
            task.status = 'miss';
            task.reason = '締切超過';
          }
        });
        user.lastPmReport = moment().tz(user.settings.timezone).format();
      }
    });
  });
}

// LINE Messaging APIのwebhookエンドポイント
app.post('/webhook', (req, res) => {
  try {
    console.log('Webhook受信:', {
      method: req.method,
      headers: req.headers,
      body: req.body
    });

    // 環境変数の確認
    if (!process.env.LINE_CHANNEL_SECRET) {
      console.error('LINE_CHANNEL_SECRETが設定されていません');
      return res.status(500).send('Server configuration error');
    }

    // 署名検証
    const signature = req.get('X-Line-Signature');
    if (!signature) {
      console.log('署名が見つかりません');
      return res.status(400).send('Bad Request - No signature');
    }

    if (!verifySignature(signature, req.rawBody, process.env.LINE_CHANNEL_SECRET)) {
      console.log('署名検証に失敗しました');
      console.log('期待するシークレット:', process.env.LINE_CHANNEL_SECRET ? '設定済み' : '未設定');
      return res.status(400).send('Bad Request - Invalid signature');
    }

    console.log('署名検証成功');

    // イベント処理
    const events = req.body.events;
    if (!events || !Array.isArray(events)) {
      console.log('イベントが無効です:', req.body);
      return res.status(400).send('Bad Request - Invalid events');
    }

    events.forEach(event => {
      handleEvent(event);
    });

    console.log('Webhook処理完了');
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook処理エラー:', error);
    res.status(500).send('Internal Server Error');
  }
});

// イベントハンドラー
function handleEvent(event) {
  console.log('イベントタイプ:', event.type);
  
  switch (event.type) {
    case 'message':
      handleMessage(event);
      break;
    case 'follow':
      handleFollow(event);
      break;
    case 'unfollow':
      handleUnfollow(event);
      break;
    case 'postback':
      handlePostback(event);
      break;
    default:
      console.log('未対応のイベントタイプ:', event.type);
  }
}

// メッセージイベントの処理
function handleMessage(event) {
  const message = event.message;
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  
  console.log('メッセージタイプ:', message.type);
  console.log('メッセージ内容:', message);
  
  if (message.type === 'text') {
    handleTextMessage(message, replyToken, userId);
  }
}

// テキストメッセージの処理
function handleTextMessage(message, replyToken, userId) {
  const userMessage = message.text;
  console.log('ユーザーメッセージ:', userMessage);
  
  const userState = getUserState(userId);
  const user = initializeUser(userId);
  
  // 状態に応じた処理
  if (userState.startsWith('awaiting_')) {
    handleStateInput(userId, userMessage, replyToken);
    return;
  }
  
  let replyText = '';
  let useQuickReply = true;
  
  if (userMessage.startsWith('am:')) {
    replyText = handleMorningCommit(userId, userMessage);
  } else if (userMessage.startsWith('pm:')) {
    replyText = handleEveningReport(userId, userMessage);
  } else if (userMessage.startsWith('/')) {
    const result = handleCommand(userId, userMessage);
    if (typeof result === 'object') {
      // 設定メニューの場合
      sendReplyMessage(replyToken, result.text, false, result.quickReply);
      return;
    }
    replyText = result;
  } else if (userMessage === '/weekly') {
    replyText = generateWeeklyReview(userId);
  } else {
    replyText = getToneMessage(user.settings.tone, 'help');
  }
  
  sendReplyMessage(replyToken, replyText, useQuickReply);
}

// 状態に応じた入力処理
function handleStateInput(userId, message, replyToken) {
  const user = initializeUser(userId);
  const userState = getUserState(userId);
  const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
  
  switch (userState) {
    case 'awaiting_am_time':
      if (timePattern.test(message)) {
        user.settings.amTime = message;
        clearUserState(userId);
        sendReplyMessage(replyToken, `朝の通知時刻を${message}に設定しました。`, true);
      } else {
        sendReplyMessage(replyToken, '正しい時刻形式で入力してください（例: 07:30）', true);
      }
      break;
      
    case 'awaiting_pm_time':
      if (timePattern.test(message)) {
        user.settings.pmTime = message;
        clearUserState(userId);
        sendReplyMessage(replyToken, `夜の通知時刻を${message}に設定しました。`, true);
      } else {
        sendReplyMessage(replyToken, '正しい時刻形式で入力してください（例: 21:30）', true);
      }
      break;
      
    case 'awaiting_weekly_time':
      if (timePattern.test(message)) {
        user.settings.weeklyTime = message;
        clearUserState(userId);
        sendReplyMessage(replyToken, `週次レビュー時刻を${message}に設定しました。`, true);
      } else {
        sendReplyMessage(replyToken, '正しい時刻形式で入力してください（例: 19:00）', true);
      }
      break;
      
    case 'awaiting_tone':
      if (['mild', 'sharp', 'dos'].includes(message.toLowerCase())) {
        user.settings.tone = message.toLowerCase();
        clearUserState(userId);
        sendReplyMessage(replyToken, `トーンを${message}に変更しました。`, true);
      } else {
        sendReplyMessage(replyToken, '使用可能なトーン: mild, sharp, dos', true);
      }
      break;
      
    case 'awaiting_deadline':
      if (timePattern.test(message)) {
        user.settings.deadline = message;
        clearUserState(userId);
        sendReplyMessage(replyToken, `締切時刻を${message}に設定しました。`, true);
      } else {
        sendReplyMessage(replyToken, '正しい時刻形式で入力してください（例: 23:00）', true);
      }
      break;
      
    case 'awaiting_tz':
      user.settings.timezone = message;
      clearUserState(userId);
      sendReplyMessage(replyToken, `タイムゾーンを${message}に設定しました。`, true);
      break;
      
    default:
      clearUserState(userId);
      sendReplyMessage(replyToken, '状態をリセットしました。', true);
  }
}

// フォローイベントの処理
function handleFollow(event) {
  console.log('ユーザーがフォローしました');
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  
  initializeUser(userId);
  const welcomeMessage = getToneMessage('mild', 'help');
  sendReplyMessage(replyToken, welcomeMessage, true);
}

// アンフォローイベントの処理
function handleUnfollow(event) {
  console.log('ユーザーがアンフォローしました');
  const userId = event.source.userId;
  users.delete(userId);
}

// ポストバックイベントの処理
function handlePostback(event) {
  console.log('ポストバックを受信しました:', event.postback.data);
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const data = event.postback.data;
  
  // 即座に返信（replyTokenは押下ごとに新規）
  switch (data) {
    case 'open:am':
      setUserState(userId, 'awaiting_am_time');
      sendReplyMessage(replyToken, '朝のリマインド時刻を hh:mm で送ってください（例: 07:30）', true);
      break;
      
    case 'open:pm':
      setUserState(userId, 'awaiting_pm_time');
      sendReplyMessage(replyToken, '夜のリマインド時刻を hh:mm で送ってください（例: 21:30）', true);
      break;
      
    case 'open:weekly':
      setUserState(userId, 'awaiting_weekly_time');
      sendReplyMessage(replyToken, '週次レビュー時刻を hh:mm で送ってください（例: 19:00）', true);
      break;
      
    case 'open:tone':
      setUserState(userId, 'awaiting_tone');
      sendReplyMessage(replyToken, '口調を選んでください: mild / sharp / dos', true);
      break;
      
    case 'open:deadline':
      setUserState(userId, 'awaiting_deadline');
      sendReplyMessage(replyToken, '締切時刻を hh:mm で送ってください（例: 23:00）', true);
      break;
      
    case 'open:tz':
      setUserState(userId, 'awaiting_tz');
      sendReplyMessage(replyToken, 'タイムゾーンを送ってください（例: Asia/Tokyo）', true);
      break;
      
    default:
      sendReplyMessage(replyToken, '不明なアクションです。', true);
  }
}

// ヘルスチェックエンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    users: users.size,
    uptime: process.uptime()
  });
});

// 定期通知を開始
scheduleNotifications();

// サーバー起動
app.listen(PORT, () => {
  console.log(`寺子屋タスクメンターがポート${PORT}で起動しました`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`ヘルスチェック: http://localhost:${PORT}/health`);
});

module.exports = app;