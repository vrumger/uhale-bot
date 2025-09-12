import { Bot, InlineKeyboard } from 'grammy';
import config from './config.json' with { type: 'json' };
import { Uhale } from './uhale.js';

const bot = new Bot(config.botToken);
const uhale = new Uhale();

const signIn = () =>
    uhale
        .login(config.email, config.password)
        .then(() => uhale.waitForLoggedIn());

let terminals;
let terminalFetchDate;
/**
 * @returns {Record<string, string>[]}
 */
const getTerminals = async () => {
    // 30 minutes
    if (terminals && Date.now() < terminalFetchDate + 1_800_000) {
        return terminals;
    }

    terminals = await uhale.getTerminals();
    terminalFetchDate = Date.now();

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

bot.on([':photo', ':video', ':document'], async ctx => {
    if (ctx.msg.document && !ctx.msg.document.mime_type.startsWith('image/')) {
        return;
    }

    const terminals = await getTerminals();
    const keyboard = new InlineKeyboard();

    terminals.forEach(terminal => {
        keyboard
            .text(
                `${terminal.name}${
                    terminal.state !== '1' || terminal.bindState !== '1'
                        ? ' (offline)'
                        : ''
                }`,
                `f:${terminal.terminalId}`,
            )
            .row();
    });

    await ctx.reply('pick a frame', {
        reply_parameters: {
            message_id: ctx.msg.message_id,
        },
        reply_markup: keyboard,
    });
});

bot.callbackQuery(/^f:(\d+)$/, async ctx => {
    const terminals = await getTerminals();
    const { terminalId, name: terminalName } = terminals.find(
        terminal => terminal.terminalId === ctx.match[1],
    );

    const replyMessage = ctx.msg.reply_to_message;

    const isImage = Boolean(
        replyMessage.photo ||
            (replyMessage.document &&
                replyMessage.document.mime_type.startsWith('image/')),
    );
    const fileTypeLabel = isImage ? 'image' : 'video';

    const editMessage = (text, other) =>
        ctx.api
            .editMessageText(ctx.chat.id, ctx.msg.message_id, text, other)
            .catch(console.error);

    await editMessage(`uploading ${fileTypeLabel}…`);

    const { file_size: fileSize, file_path: filePath } = await ctx.api.getFile(
        replyMessage.photo.at(-1).file_id,
    );

    const request = await fetch(
        `https://api.telegram.org/file/bot${bot.token}/${filePath}`,
    );
    const response = await request.arrayBuffer();

    const sessionIdState = await uhale.getSessionIdState();
    if (sessionIdState !== 'loggedIn') {
        await signIn();
    }

    const { awsUploadUrl, fileUrl, fileId } = await uhale.getPresignedUrl({
        isImage,
        fileSize,
        terminalId,
    });

    await fetch(awsUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: response,
    });

    await editMessage(`${fileTypeLabel} uploaded. saving to ${terminalName}…`);

    await uhale.saveUploadedFile({
        fileUrl,
        fileId,
        fileSize,
        subject: replyMessage.text,
        terminalId,
    });

    await uhale.waitForFilesUploaded([fileId]);

    await editMessage(
        `${fileTypeLabel} uploaded and saved to ${terminalName}.`,
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

    await ctx.answerCallbackQuery(`revoking ${fileType}…`);

    const sessionIdState = await uhale.getSessionIdState();
    if (sessionIdState !== 'loggedIn') {
        await signIn();
    }

    await uhale.revokeFiles(terminalId, [fileId]);
    await uhale.waitForFilesRevoked([fileId]);

    await ctx.editMessageText(`${fileType} revoked`);
});

signIn()
    .then(() => console.log('logged in'))
    .then(() =>
        bot.start({
            onStart: () => console.log('bot started'),
        }),
    );
