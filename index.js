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

bot.on([':photo', ':video', ':document'], async ctx => {
    if (ctx.msg.document && !ctx.msg.document.mime_type.startsWith('image/')) {
        return;
    }

    const isImage = Boolean(
        ctx.msg.photo ||
            (ctx.msg.document &&
                ctx.msg.document.mime_type.startsWith('image/')),
    );
    const fileTypeLabel = isImage ? 'image' : 'video';

    const { message_id: messageId } = await ctx.reply(
        `uploading ${fileTypeLabel}…`,
        {
            reply_parameters: {
                message_id: ctx.msg.message_id,
                allow_sending_without_reply: true,
            },
        },
    );

    const editMessage = (text, other) =>
        ctx.api
            .editMessageText(ctx.chat.id, messageId, text, other)
            .catch(console.error);

    const { file_size: fileSize, file_path: filePath } = await ctx.getFile();

    const request = await fetch(
        `https://api.telegram.org/file/bot${bot.token}/${filePath}`,
    );
    const response = await request.arrayBuffer();

    const sessionIdState = await uhale.getSessionIdState();
    if (sessionIdState !== 'loggedIn') {
        await signIn();
    }

    const [{ terminalId, name: terminalName }] = await getTerminals();
    const { awsUploadUrl, fileUrl, fileId } = await uhale.getPresignedUrl({
        isImage,
        fileSize,
        terminalId,
    });

    await fetch(awsUploadUrl, {
        method: 'PUT',
        body: response,
    });

    await editMessage(`${fileTypeLabel} uploaded. saving to ${terminalName}…`);

    await uhale.saveUploadedFile({
        fileUrl,
        fileId,
        fileSize,
        subject: isImage ? 'image.jpg' : 'video.mp4',
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
