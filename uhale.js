import { createHmac, randomUUID } from 'node:crypto';

export class Uhale {
    constructor(options) {
        options = options ?? {};

        this.apiUrl =
            options.apiUrl ?? 'https://whalephoto.zeasn.tv/photo/api/v1/web';
        this.userUrl = options.userUrl ?? 'https://saas.zeasn.tv';
        this.secretKey =
            options.secretKey ?? '10f0e356f1d0e64b18b1d02535dc45fb86';
        this.accessKey =
            options.accessKey ?? '12d2f87794d58c4044a7e9d8069a955b70';

        this.sessionId = null;
        this.user = null;
    }

    _handleResponse(response) {
        if (response.errorCode && response.errorCode !== '0') {
            throw new Error(`${response.errorCode}: ${response.errorMsg}`);
        }

        return response.data;
    }

    async _getSessionId(userToken) {
        let url = this.apiUrl;
        const params = new URLSearchParams();

        if (userToken) {
            url += '/getSessionId';
            params.set('userToken', userToken);
        } else {
            url += '/sessionId';
        }

        const request = await fetch(`${url}?${params}`, {
            headers: { sessionId: this.sessionId ?? '' },
        });
        const response = await request.json();
        const data = this._handleResponse(response);

        this.sessionId = data;
    }

    async _getSessionIdState() {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const params = new URLSearchParams({ sessionId: this.sessionId });
        const request = await fetch(`${this.apiUrl}/sessionIdState?${params}`, {
            headers: { sessionId: this.sessionId },
        });
        const response = await request.json();
        const data = this._handleResponse(response);

        const states = {
            0: 'loggedOut',
            1: 'scanned',
            2: 'loggedIn',
            3: 'failed',
            4: 'expired',
        };

        return states[data] ?? 'unknown';
    }

    _generateSignedToken(path) {
        const timestamp = Date.now();
        const signature = createHmac('sha1', this.secretKey)
            .update(path + timestamp)
            .digest('base64');

        return `${this.accessKey}:${signature}:${timestamp}`;
    }

    async _login(email, password) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const params = new URLSearchParams({ email, pwd: password });
        const request = await fetch(
            `${this.userUrl}/user/device/login?${params}`,
            {
                method: 'POST',
                headers: {
                    brandId: '7',
                    productId: '855',
                    sessionId: this.sessionId,
                    authorization:
                        this._generateSignedToken('/user/device/login'),
                },
            },
        );
        const response = await request.json();
        const data = this._handleResponse(response);

        this.user = {
            token: data.userToken,
            expiresAt: data.expireAt,
        };
    }

    async login(email, password) {
        if (!email || !password) {
            throw new Error('email and password are required');
        }

        await this._getSessionId();
        await this._login(email, password);
        await this._getSessionId(this.user.token);
    }

    waitForLoggedIn(maxAttempts = 5) {
        return new Promise((resolve, reject) => {
            let attempts = 0;

            const checkSessionIdState = async () => {
                try {
                    attempts++;

                    const sessionIdState = await this._getSessionIdState();

                    if (sessionIdState === 'loggedIn') {
                        clearInterval(interval);
                        resolve();
                    } else if (
                        sessionIdState === 'failed' ||
                        sessionIdState === 'expired'
                    ) {
                        clearInterval(interval);
                        reject(new Error(`Login ${sessionIdState}`));
                    } else if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        reject(new Error('Polling timeout'));
                    }
                } catch (error) {
                    clearInterval(interval);
                    reject(error);
                }
            };

            const interval = setInterval(checkSessionIdState, 3000);
            checkSessionIdState();
        });
    }

    async getPresignedUrl({ isImage, fileSize, terminalId }) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const params = new URLSearchParams({
            filenameExtension: isImage ? '.jpg' : '.mp4',
            fileSize,
            terminalId,
            offlineStorage: 'false', // !isPhotoFrameOnline
            _t: Date.now() / 1000 + randomUUID(),
        });

        const request = await fetch(`${this.apiUrl}/presignedUrl?${params}`, {
            headers: { sessionId: this.sessionId },
        });
        const response = await request.json();

        return this._handleResponse(response);
    }

    async saveUploadedFile({ fileUrl, fileId, subject, fileSize, terminalId }) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const request = await fetch(`${this.apiUrl}/file`, {
            method: 'POST',
            headers: {
                sessionId: this.sessionId,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                fileUrl,
                fileId,
                fileSize,
                subject,
                terminalId,
            }),
        });
        const response = await request.json();

        this._handleResponse(response);
    }

    async _getFileState(fileIds) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const request = await fetch(`${this.apiUrl}/getFileState`, {
            method: 'POST',
            headers: {
                sessionId: this.sessionId,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ fileIds }),
        });
        const response = await request.json();
        const data = this._handleResponse(response);

        const states = {
            1: 'pending',
            2: 'uploaded', // image
            3: 'uploaded', // video
        };

        return Object.entries(data).map(([fileId, fileState]) => [
            fileId,
            states[fileState] ?? fileState ?? 'unknown',
        ]);
    }

    waitForFilesUploaded(fileIds, maxAttempts = Infinity) {
        return new Promise((resolve, reject) => {
            let attempts = 0;

            const checkFileStates = async () => {
                try {
                    attempts++;

                    const fileStates = await this._getFileState(fileIds);

                    if (
                        fileStates.every(
                            ([_fileId, fileState]) => fileState === 'uploaded',
                        )
                    ) {
                        clearInterval(interval);
                        resolve();
                    } else if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        reject(new Error('Polling timeout'));
                    }
                } catch (error) {
                    clearInterval(interval);
                    reject(error);
                }
            };

            const interval = setInterval(checkFileStates, 3000);
            checkFileStates();
        });
    }

    async uploadFile({ isImage, file, fileSize, terminalId }) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        fileSize = fileSize ?? file.length;

        const { awsUploadUrl, fileUrl, fileId } = await this.getPresignedUrl({
            isImage,
            fileSize,
            terminalId,
        });

        await fetch(awsUploadUrl, {
            method: 'PUT',
            body: file,
        });

        await this.saveUploadedFile({
            fileUrl,
            fileId,
            fileSize,
            subject: isImage ? 'image.jpg' : 'video.mp4',
            terminalId,
        });

        await this.waitForFilesUploaded([fileId]);

        return fileId;
    }

    async revokeFiles(terminalId, fileIds) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const request = await fetch(`${this.apiUrl}/revoke`, {
            method: 'POST',
            headers: {
                sessionId: this.sessionId,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                terminalId,
                fileIds,
                offlineStorage: false,
            }),
        });
        const response = await request.json();

        return this._handleResponse(response);
    }

    async _getFileRevokeState(fileIds) {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const params = new URLSearchParams({ fileIds: fileIds.join(',') });
        const request = await fetch(`${this.apiUrl}/revoke?${params}`, {
            headers: { sessionId: this.sessionId },
        });
        const response = await request.json();
        const data = this._handleResponse(response);

        const states = {
            1: 'pending',
            2: 'revoked',
        };

        return Object.entries(data).map(([fileId, fileState]) => [
            fileId,
            states[fileState] ?? 'unknown',
        ]);
    }

    waitForFilesRevoked(fileIds, maxAttempts = Infinity) {
        return new Promise((resolve, reject) => {
            let attempts = 0;

            const checkFileStates = async () => {
                try {
                    attempts++;

                    const fileStates = await this._getFileRevokeState(fileIds);

                    if (
                        fileStates.every(
                            ([_fileId, fileState]) => fileState === 'revoked',
                        )
                    ) {
                        clearInterval(interval);
                        resolve();
                    } else if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        reject(new Error('Polling timeout'));
                    }
                } catch (error) {
                    clearInterval(interval);
                    reject(error);
                }
            };

            const interval = setInterval(checkFileStates, 3000);
            checkFileStates();
        });
    }

    async getTerminals() {
        if (!this.sessionId) {
            throw new Error('no session id');
        }

        const request = await fetch(`${this.apiUrl}/terminal`, {
            headers: { sessionId: this.sessionId },
        });
        const response = await request.json();

        return this._handleResponse(response);
    }
}
