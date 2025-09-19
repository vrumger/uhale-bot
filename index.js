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

    terminals = (await uhale.getTerminals()).sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId),
    );
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

/**
 * @param {Record<string, string>} terminal
 * @param {import('grammy/types').Message} msg
 * @returns
 */
const uploadFile = async (terminal, msg, editMessage) => {
    const isImage = Boolean(
        msg.photo ||
            (msg.document && msg.document.mime_type.startsWith('image/')),
    );
    const fileTypeLabel = isImage ? 'image' : 'video';

    await editMessage(`uploading ${fileTypeLabel}…`);

    const file = msg.photo?.at(-1) ?? msg.video ?? msg.document;

    let fileSize, filePath;
    try {
        ({ file_size: fileSize, file_path: filePath } = await bot.api.getFile(
            file.file_id,
        ));
    } catch (error) {
        await editMessage(error.message || 'there was an error', {
            reply_markup: new InlineKeyboard().text(
                'Retry',
                `f:${terminal.terminalId}`,
            ),
        });
        return;
    }

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
        terminalId: terminal.terminalId,
    });

    await fetch(awsUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: response,
    });

    await editMessage(`${fileTypeLabel} uploaded. saving to ${terminal.name}…`);

    await uhale.saveUploadedFile({
        fileUrl,
        fileId,
        fileSize,
        subject: msg.text,
        terminalId: terminal.terminalId,
    });

    await uhale.waitForFilesUploaded([fileId]);

    await editMessage(
        `${fileTypeLabel} uploaded and saved to ${terminal.name}.`,
        {
            reply_markup: new InlineKeyboard().text(
                'Revoke',
                `r:${isImage ? 'i' : 'v'}:${terminal.terminalId}:${fileId}`,
            ),
        },
    );
};

bot.on([':photo', ':video', ':document'], async ctx => {
    if (
        ctx.msg.document &&
        !ctx.msg.document.mime_type.startsWith('image/') &&
        !ctx.msg.document.mime_type.startsWith('video/')
    ) {
        return;
    }

    let terminals;
    try {
        terminals = await getTerminals();
    } catch (error) {
        if (error.message === '600104: sessionId is invalid') {
            await signIn();
            terminals = await getTerminals();
        } else {
            throw error;
        }
    }

    if (ctx.msg.reply_to_message?.forum_topic_created) {
        const terminal = terminals.find(
            terminal =>
                terminal.name ===
                ctx.msg.reply_to_message.forum_topic_created.name,
        );

        if (terminal) {
            /**
             * @type {import('grammy/types').Message | undefined}
             */
            let responseMessage;

            const editMessage = async (text, other) => {
                if (responseMessage) {
                    await ctx.api
                        .editMessageText(
                            ctx.chat.id,
                            responseMessage.message_id,
                            text,
                            other,
                        )
                        .catch(console.error);
                } else {
                    responseMessage = await ctx.api
                        .sendMessage(ctx.chat.id, text, {
                            ...other,
                            reply_parameters: {
                                ...other?.reply_parameters,
                                message_id: ctx.msg.message_id,
                            },
                        })
                        .catch(console.error);
                }
            };

            try {
                await uploadFile(terminal, ctx.msg, editMessage);
            } catch (error) {
                console.error(error);
                await editMessage(error.message || 'there was an error', {
                    reply_markup: new InlineKeyboard().text(
                        'Retry',
                        `f:${terminal.terminalId}`,
                    ),
                });
            }

            return;
        }
    }

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
    const terminal = terminals.find(
        terminal => terminal.terminalId === ctx.match[1],
    );

    const editMessage = (text, other) =>
        ctx.api
            .editMessageText(ctx.chat.id, ctx.msg.message_id, text, other)
            .catch(console.error);

    await ctx.answerCallbackQuery();
    await uploadFile(terminal, ctx.msg.reply_to_message, editMessage);
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
