require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ============================================================
//  НАСТРОЙКИ (берутся из .env — см. .env.example)
// ============================================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;   // необязательно: если указан — команды появляются мгновенно на одном сервере
const OWNER_ID = process.env.OWNER_ID;   // только этот Discord ID может выдавать монеты

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error('❌ Заполни DISCORD_TOKEN, CLIENT_ID и OWNER_ID в файле .env (см. .env.example)');
  process.exit(1);
}

// ============================================================
//  ХРАНИЛИЩЕ ДАННЫХ — простой JSON-файл рядом с ботом
// ============================================================
const DB_PATH = path.join(__dirname, 'economy.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}');
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}
let db = loadDB();

function getProfile(userId) {
  if (!db[userId]) {
    db[userId] = { balance: 0, wins: 0, losses: 0, netProfit: 0 };
    saveDB(db);
  }
  return db[userId];
}
function formatCoins(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toLocaleString('ru-RU')} 🪙`;
}

// ============================================================
//  ЛОГИКА РУЛЕТКИ (европейская, числа 0-36, стандартные правила)
// ============================================================
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function colorOf(n) { return n === 0 ? 'green' : (RED_NUMBERS.has(n) ? 'red' : 'black'); }
function dozenOf(n) { if (n === 0) return null; return n <= 12 ? '1' : (n <= 24 ? '2' : '3'); }
function columnOf(n) { if (n === 0) return null; const m = n % 3; return m === 1 ? '1' : (m === 2 ? '2' : '3'); }

// Стандартные казино-мультипликаторы (полная выплата, ставка уже входит в неё)
const PAYOUTS = {
  number: 36,   // ставка на число
  color: 2,     // красное/чёрное
  even_odd: 2,  // чёт/нечет
  half: 2,      // 1-18 / 19-36
  dozen: 3,     // дюжина (12 чисел)
  column: 3,    // колонка (12 чисел)
};

const TYPE_LABELS = {
  number: 'число от 0 до 36, например 17',
  color: 'red или black',
  even_odd: 'even или odd',
  half: 'low (1-18) или high (19-36)',
  dozen: '1, 2 или 3 (дюжина)',
  column: '1, 2 или 3 (колонка)',
};

function isValidValue(type, value) {
  if (type === 'number') { const n = Number(value); return Number.isInteger(n) && n >= 0 && n <= 36; }
  if (type === 'color') return ['red', 'black'].includes(value);
  if (type === 'even_odd') return ['even', 'odd'].includes(value);
  if (type === 'half') return ['low', 'high'].includes(value);
  if (type === 'dozen') return ['1', '2', '3'].includes(value);
  if (type === 'column') return ['1', '2', '3'].includes(value);
  return false;
}

function isWin(type, value, landed) {
  if (type === 'number') return Number(value) === landed;
  if (landed === 0) return false; // зеро — все остальные ставки проигрывают, как в настоящем казино
  if (type === 'color') return colorOf(landed) === value;
  if (type === 'even_odd') return (landed % 2 === 0 ? 'even' : 'odd') === value;
  if (type === 'half') return (landed <= 18 ? 'low' : 'high') === value;
  if (type === 'dozen') return dozenOf(landed) === value;
  if (type === 'column') return columnOf(landed) === value;
  return false;
}

// ============================================================
//  DISCORD-КЛИЕНТ И КОМАНДЫ
// ============================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('профиль')
    .setDescription('Показать баланс и статистику ставок')
    .addUserOption(o => o.setName('игрок').setDescription('Чей профиль показать').setRequired(false)),

  new SlashCommandBuilder()
    .setName('выдать')
    .setDescription('Выдать (или списать) монеты игроку — только владелец бота')
    .addUserOption(o => o.setName('игрок').setDescription('Кому выдать').setRequired(true))
    .addIntegerOption(o => o.setName('количество').setDescription('Сколько монет (отрицательное число — списать)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('рулетка')
    .setDescription('Сделать ставку в рулетке')
    .addStringOption(o => o.setName('тип')
      .setDescription('Тип ставки')
      .setRequired(true)
      .addChoices(
        { name: 'Число (x36)', value: 'number' },
        { name: 'Цвет red/black (x2)', value: 'color' },
        { name: 'Чёт/нечет (x2)', value: 'even_odd' },
        { name: 'Половина low/high (x2)', value: 'half' },
        { name: 'Дюжина 1/2/3 (x3)', value: 'dozen' },
        { name: 'Колонка 1/2/3 (x3)', value: 'column' },
      ))
    .addStringOption(o => o.setName('значение').setDescription('Например: 17 / red / even / low / 2').setRequired(true))
    .addIntegerOption(o => o.setName('ставка').setDescription('Сколько монет поставить').setRequired(true)),

  new SlashCommandBuilder()
    .setName('помощь')
    .setDescription('Список команд и типов ставок'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(GUILD_ID
    ? '✅ Команды зарегистрированы на сервере (появятся мгновенно).'
    : '✅ Команды зарегистрированы глобально (обновление до ~1 часа).');
}

// ============================================================
//  ОБРАБОТКА КОМАНД
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ---------- /профиль ----------
  if (interaction.commandName === 'профиль') {
    const target = interaction.options.getUser('игрок') || interaction.user;
    const p = getProfile(target.id);
    const netLabel = p.netProfit > 0 ? `📈 +${formatCoins(p.netProfit)}`
      : p.netProfit < 0 ? `📉 -${formatCoins(Math.abs(p.netProfit))}`
      : `➖ ${formatCoins(0)}`;

    const embed = new EmbedBuilder()
      .setTitle(`Профиль — ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'Баланс', value: formatCoins(p.balance), inline: true },
        { name: 'Побед / Поражений', value: `${p.wins} / ${p.losses}`, inline: true },
        { name: 'Итог по ставкам', value: netLabel, inline: false },
      )
      .setFooter({ text: '1 монета = 10 000 000 игровых единиц' })
      .setColor(0xE8B64C);
    return interaction.reply({ embeds: [embed] });
  }

  // ---------- /выдать ----------
  if (interaction.commandName === 'выдать') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: '⛔ Эта команда доступна только владельцу бота.', ephemeral: true });
    }
    const target = interaction.options.getUser('игрок');
    const amount = interaction.options.getInteger('количество');
    const p = getProfile(target.id);
    p.balance += amount;
    saveDB(db);
    return interaction.reply(`✅ Выдано ${formatCoins(amount)} игроку **${target.username}**. Новый баланс: ${formatCoins(p.balance)}.`);
  }

  // ---------- /рулетка ----------
  if (interaction.commandName === 'рулетка') {
    const type = interaction.options.getString('тип');
    const value = interaction.options.getString('значение').toLowerCase().trim();
    const bet = interaction.options.getInteger('ставка');

    if (bet <= 0) {
      return interaction.reply({ content: '⚠️ Ставка должна быть больше нуля.', ephemeral: true });
    }
    if (!isValidValue(type, value)) {
      return interaction.reply({ content: `⚠️ Неверное значение для этого типа ставки. Ожидается: ${TYPE_LABELS[type]}`, ephemeral: true });
    }

    const p = getProfile(interaction.user.id);
    if (p.balance < bet) {
      return interaction.reply({ content: `⚠️ Недостаточно монет. Твой баланс: ${formatCoins(p.balance)}.`, ephemeral: true });
    }

    // Списываем ставку и крутим барабан — честный рандом, без подкруток и заранее заданных исходов
    p.balance -= bet;
    const landed = Math.floor(Math.random() * 37); // 0..36
    const win = isWin(type, value, landed);
    const landedColor = colorOf(landed);
    const colorTag = landedColor === 'red' ? '🔴 red' : landedColor === 'black' ? '⚫ black' : '🟢 zero';

    let resultLine;
    if (win) {
      const payout = bet * PAYOUTS[type];
      p.balance += payout;
      p.wins += 1;
      p.netProfit += (payout - bet);
      resultLine = `🟢 **Победа!** Выигрыш: ${formatCoins(payout)} (x${PAYOUTS[type]})`;
    } else {
      p.losses += 1;
      p.netProfit -= bet;
      resultLine = `🔴 **Поражение.** Потеряно: ${formatCoins(bet)}`;
    }
    saveDB(db);

    const embed = new EmbedBuilder()
      .setTitle('🎰 Рулетка')
      .setDescription(
        `Выпало число: **${landed}** (${colorTag})\n\n${resultLine}\n\nНовый баланс: ${formatCoins(p.balance)}`
      )
      .setColor(win ? 0x1F9D55 : 0xD81E2C);
    return interaction.reply({ embeds: [embed] });
  }

  // ---------- /помощь ----------
  if (interaction.commandName === 'помощь') {
    const embed = new EmbedBuilder()
      .setTitle('📖 Команды')
      .addFields(
        { name: '/профиль [игрок]', value: 'Баланс, побед/поражений и общий итог по ставкам.' },
        { name: '/выдать <игрок> <количество>', value: 'Выдать монеты (только владелец бота).' },
        { name: '/рулетка <тип> <значение> <ставка>', value: 'Сделать ставку.' },
        { name: 'Типы ставок', value: Object.entries(TYPE_LABELS).map(([k, v]) => `**${k}** (x${PAYOUTS[k]}) — ${v}`).join('\n') },
      )
      .setColor(0xE8B64C);
    return interaction.reply({ embeds: [embed] });
  }
});

client.once('ready', () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
