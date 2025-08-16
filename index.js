import { Bot, InlineKeyboard } from 'grammy';
import config from './config.json' with { type: 'json' };
import { Uhale } from './uhale.js';

const bot = new Bot(config.botToken);
const uhale = new Uhale();

let terminals;
const getTerminals = async () => {
    if (terminals) {
        return terminals;
    }

    terminals = await uhale.getTerminals();
    return terminals;
};

bot.use((ctx, next) => {
    if (!config.allowedUsers.includes(ctx.from.id)) {
        return;
    }

    next();
});

bot.command('start', async ctx => {
    const terminals = (await getTerminals()).map(
        terminal =>
            `- ${terminal.name}${
                terminal.state !== '1' || terminal.bindState !== '1'
                    ? ' (offline)'
                    : ''
            }`,
    );

    await ctx.reply('terminals:\n' + terminals.join('\n'));
});

bot.on([':photo', ':video'], async ctx => {
    const isImage = Boolean(ctx.msg.photo);
    const fileTypeLabel = isImage ? 'image' : 'video';

    const { message_id: messageId } = await ctx.reply(
        `uploading ${fileTypeLabel}...`,
        {
            reply_parameters: {
                message_id: ctx.msg.message_id,
                allow_sending_without_reply: true,
            },
        },
    );

    const { file_size: fileSize, file_path: filePath } = await ctx.getFile();

    const request = await fetch(
        `https://api.telegram.org/file/bot${bot.token}/${filePath}`,
    );
    const response = await request.arrayBuffer();

    const [{ terminalId }] = await getTerminals();
    const fileId = await uhale.uploadFile({
        isImage,
        file: response,
        fileSize,
        terminalId,
    });

    await ctx.api.editMessageText(
        ctx.chat.id,
        messageId,
        `${fileTypeLabel} uploaded`,
        {
            reply_markup: new InlineKeyboard().text(
                'Revoke',
                `r:${isImage ? 'i' : 'v'}:${terminalId}:${fileId}`,
            ),
        },
    );
});

bot.callbackQuery(/^r:(i|v):(\w+):(\w+)$/, async ctx => {
    const [, _fileType, terminalId, fileId] = ctx.match;
    const fileType = _fileType === 'i' ? 'image' : 'video';

    await ctx.answerCallbackQuery(`revoking ${fileType}...`);

    await uhale.revokeFiles(terminalId, [fileId]);
    await uhale._waitForFilesRevoked([fileId]);

    await ctx.editMessageText(`${fileType} revoked`);
});

uhale
    .login(config.email, config.password)
    .then(() => uhale.waitForLoggedIn())
    .then(() => console.log('logged in'))
    .then(() =>
        bot.start({
            onStart: () => console.log('bot started'),
        }),
    );
