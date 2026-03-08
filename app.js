/**
 * 教員用出席確認アプリ
 * メインロジック（カレンダー・時限対応版）
 */

// データモデル定数
const STUDENT_STATUS = {
    NORMAL: '通常',
    TRANSFER: 'クラス移項',
    DROPOUT: '退学',
    LONG_ABSENT: '長期欠席'
};

const ATTENDANCE_TYPES = {
    PRESENT: '出席',
    ABSENT: '欠席',
    SUSPEND: '出校停止',
    OFFICIAL: '公欠',
    MOURNING: '忌引き'
};

const PERIODS = ['1限', '2限', '3限', '4限', '5限', '6限', '7限', '放課後'];

// ユーティリティ
const generateId = () => '_' + Math.random().toString(36).substr(2, 9);
const getTodayString = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const formatDateStr = (year, month, day) => {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

//==============================================
// Storage Manager
// ローカルストレージとのデータのやり取りを管理
//==============================================
class StorageManager {
    constructor() {
        this.STORAGE_KEY = 'attendance_app_data_v2'; // データ構造変更のためv2とする
        this.IDB_DB_NAME = 'AttendanceAppDB';
        this.IDB_STORE_NAME = 'handlesStore';
        this.IDB_KEY_HANDLE = 'recentFileHandle';

        this.fileHandle = null;
        
        // GitHub API Settings
        this.ghSettings = this.loadGitHubSettings();
        
        this.data = this.loadDataFromLocal(); // Backup/Default source
    }

    // --- GitHub API Settings ---
    loadGitHubSettings() {
        const str = localStorage.getItem('gh_sync_settings');
        if (str) {
            try { return JSON.parse(str); } catch (e) { }
        }
        return { owner: '', repo: '', path: 'data.json', token: '', enabled: false, lastSha: null };
    }

    saveGitHubSettings(settings) {
        this.ghSettings = { ...this.ghSettings, ...settings };
        localStorage.setItem('gh_sync_settings', JSON.stringify(this.ghSettings));
    }

    // Sync UI Update callback
    setSyncCallback(callback) {
        this.syncCallback = callback;
    }

    updateSyncStatus(status) {
        if (this.syncCallback) this.syncCallback(status);
    }

    loadDataFromLocal() {
        const json = localStorage.getItem(this.STORAGE_KEY);
        if (json) {
            try {
                return JSON.parse(json);
            } catch (e) {
                console.error("データのパースに失敗しました", e);
            }
        }
        // 初期状態
        return {
            classes: [], // [{ id, name, students: [{ id, number, name, status }] }]
            attendance: {} // { "yyyy-mm-dd": { "1限": { classId: "c1", records: { "s_1": "出席" } } } }
        };
    }

    saveDataToLocal() {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
    }

    async saveData() {
        this.saveDataToLocal(); // Always keep local copy as fallback

        if (this.ghSettings && this.ghSettings.enabled) {
            return await this.saveDataToGitHub();
        }

        if (this.fileHandle) {
            try {
                this.updateSyncStatus('syncing');
                // Verify permission before writing
                if (await this.verifyPermission(this.fileHandle, true)) {
                    const writable = await this.fileHandle.createWritable();
                    await writable.write(JSON.stringify(this.data, null, 2));
                    await writable.close();
                    this.updateSyncStatus('synced');
                    return true;
                } else {
                    this.updateSyncStatus('error');
                    throw new Error('Permission denied');
                }
            } catch (err) {
                console.error('Failed to save to file system', err);
                this.updateSyncStatus('error');
                return false;
            }
        }
        return true;
    }

    // --- File System Access API ---

    async createNewFile() {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: `attendance_data_${getTodayString()}.json`,
                types: [{
                    description: 'JSON Files',
                    accept: { 'application/json': ['.json'] },
                }],
            });
            this.fileHandle = handle;
            await this.saveFileHandleToIDB(handle);
            await this.saveData(); // Initial save to the new file
            return true;
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Error creating new file:', err);
            return false;
        }
    }

    async openExistingFile() {
        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'JSON Files',
                    accept: { 'application/json': ['.json'] },
                }],
            });
            this.fileHandle = handle;
            await this.saveFileHandleToIDB(handle);

            this.updateSyncStatus('syncing');
            const file = await handle.getFile();
            const contents = await file.text();

            const parsed = JSON.parse(contents);
            if (parsed.classes && parsed.attendance) {
                this.data = parsed;
                this.saveDataToLocal(); // Update local storage with new file's data
                this.updateSyncStatus('synced', file.name);
                return true;
            } else {
                this.fileHandle = null;
                this.updateSyncStatus('disconnected');
                throw new Error('Invalid data format in file');
            }
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Error opening file:', err);
            this.updateSyncStatus('disconnected');
            return false;
        }
    }

    async reloadStoredFile() {
        try {
            if (!this.fileHandle) return false;

            // Require UI gesture to trigger permission dialog if needed
            if (await this.verifyPermission(this.fileHandle, true)) {
                this.updateSyncStatus('syncing');
                const file = await this.fileHandle.getFile();
                const contents = await file.text();

                const parsed = JSON.parse(contents);
                if (parsed.classes && parsed.attendance) {
                    this.data = parsed;
                    this.saveDataToLocal();
                    this.updateSyncStatus('synced', file.name);
                    return true;
                }
            } else {
                console.error('Permission not granted');
            }
            return false;
        } catch (err) {
            console.error('Failed to reload file:', err);
            this.fileHandle = null;
            await this.clearFileHandleFromIDB();
            this.updateSyncStatus('disconnected');
            return false;
        }
    }

    async verifyPermission(fileHandle, readWrite) {
        const options = {};
        if (readWrite) {
            options.mode = 'readwrite';
        }
        if ((await fileHandle.queryPermission(options)) === 'granted') {
            return true;
        }
        if ((await fileHandle.requestPermission(options)) === 'granted') {
            return true;
        }
        return false;
    }

    // --- GitHub API Sync ---

    async testGitHubConnection(owner, repo, path, token) {
        try {
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            const response = await fetch(url, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            
            if (response.status === 200) {
                return { success: true, message: '接続成功！既存のファイルが見つかりました。' };
            } else if (response.status === 404) {
                return { success: true, message: '接続成功！新しいファイルとして作成されます。' };
            } else if (response.status === 401) {
                return { success: false, message: '認証エラー：Tokenが間違っているか、権限がありません。' };
            } else {
                return { success: false, message: `エラー：HTTP ${response.status}` };
            }
        } catch (err) {
            return { success: false, message: `通信エラー：${err.message}` };
        }
    }

    async loadDataFromGitHub() {
        if (!this.ghSettings.enabled || !this.ghSettings.token) return false;
        
        this.updateSyncStatus('syncing');
        try {
            const { owner, repo, path, token } = this.ghSettings;
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (response.status === 200) {
                const result = await response.json();
                
                // Decode Base64 content properly (handling UTF-8)
                const binaryString = atob(result.content);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                const decoder = new TextDecoder('utf-8');
                const jsonString = decoder.decode(bytes);
                
                const parsed = JSON.parse(jsonString);
                
                if (parsed.classes && parsed.attendance) {
                    this.data = parsed;
                    this.saveDataToLocal();
                    
                    // Save the SHA for future updates to avoid conflict
                    this.saveGitHubSettings({ lastSha: result.sha });
                    
                    this.updateSyncStatus('synced', `GitHub: ${repo}/${path}`);
                    return true;
                } else {
                    throw new Error('Invalid data format in GitHub file');
                }
            } else if (response.status === 404) {
                // File doesn't exist yet, we will create it on next save
                this.updateSyncStatus('synced', `GitHub: (New) ${repo}/${path}`);
                return true;
            } else {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (err) {
            console.error('Failed to load from GitHub:', err);
            this.updateSyncStatus('disconnected');
            return false;
        }
    }

    async saveDataToGitHub() {
        if (!this.ghSettings.enabled || !this.ghSettings.token) return false;
        
        this.updateSyncStatus('syncing');
        try {
            const { owner, repo, path, token, lastSha } = this.ghSettings;
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            
            // Encode data to Base64 (handling UTF-8)
            const jsonString = JSON.stringify(this.data, null, 2);
            const encoder = new TextEncoder();
            const bytes = encoder.encode(jsonString);
            let binaryString = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binaryString += String.fromCharCode(bytes[i]);
            }
            const b64Content = btoa(binaryString);

            const body = {
                message: `Update attendance data via App - ${getTodayString()}`,
                content: b64Content
            };
            
            if (lastSha) {
                body.sha = lastSha;
            }

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (response.status === 200 || response.status === 201) {
                const result = await response.json();
                this.saveGitHubSettings({ lastSha: result.content.sha });
                this.updateSyncStatus('synced', `GitHub: ${repo}/${path}`);
                return true;
            } else if (response.status === 409) {
                // Conflict - someone else updated it. 
                // In a perfect world we would merge, but for now we'll just fail gracefully.
                this.updateSyncStatus('error');
                alert('GitHub上でのデータ衝突（コンフリクト）が発生しました。\n他の端末からの同時編集などでファイルが書き換えられています。');
                return false;
            } else {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (err) {
            console.error('Failed to save to GitHub:', err);
            this.updateSyncStatus('error');
            return false;
        }
    }

    // --- IndexedDB for File Handle Persistence ---
    _getDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.IDB_DB_NAME, 1);
            request.onerror = (e) => reject(e);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.IDB_STORE_NAME)) {
                    db.createObjectStore(this.IDB_STORE_NAME);
                }
            };
        });
    }

    async saveFileHandleToIDB(handle) {
        try {
            const db = await this._getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.IDB_STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.IDB_STORE_NAME);
                const req = store.put(handle, this.IDB_KEY_HANDLE);
                req.onsuccess = () => resolve();
                req.onerror = (e) => reject(e);
            });
        } catch (err) {
            console.error('Failed to save to IDB', err);
        }
    }

    async loadStoredFileHandle() {
        try {
            const db = await this._getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.IDB_STORE_NAME, 'readonly');
                const store = tx.objectStore(this.IDB_STORE_NAME);
                const req = store.get(this.IDB_KEY_HANDLE);
                req.onsuccess = () => {
                    if (req.result) {
                        this.fileHandle = req.result;
                        resolve(this.fileHandle);
                    } else {
                        resolve(null);
                    }
                };
                req.onerror = (e) => reject(e);
            });
        } catch (err) {
            console.error('Failed to load from IDB', err);
            return null;
        }
    }

    async clearFileHandleFromIDB() {
        try {
            const db = await this._getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.IDB_STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.IDB_STORE_NAME);
                const req = store.delete(this.IDB_KEY_HANDLE);
                req.onsuccess = () => resolve();
                req.onerror = (e) => reject(e);
            });
        } catch (err) {
            console.error('Failed to clear from IDB', err);
        }
    }

    // JSONエクスポート
    exportData() {
        const dataStr = JSON.stringify(this.data, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `attendance_backup_${getTodayString()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // JSONインポート
    importData(jsonString) {
        try {
            const parsed = JSON.parse(jsonString);
            if (parsed.classes && parsed.attendance) {
                this.data = parsed;
                this.saveData();
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }
}

//==============================================
// UI Controller
// 画面全体の制御
//==============================================
class UIController {
    constructor() {
        this.storage = new StorageManager();
        this.currentViewId = 'view-attendance-input';

        // State
        this.calendarDate = new Date();
        this.editingClassId = null;

        // Attendance Editor State
        this.attEditingDate = null;
        this.attEditingOriginalPeriod = null; // 編集時の元の時限情報

        // Summary State
        this.summaryDetailsData = {}; // "sid_type" -> ["2026-02-26 1限", ...]

        this.init();
    }

    async init() {
        this.setupNavigation();
        this.setupGlobals();

        // Listen to sync status changes from StorageManager
        this.storage.setSyncCallback((status, filename) => this.handleSyncStatusUpdate(status, filename));

        // 各ビューの初期化
        this.initAttendanceInputView();
        this.initAttendanceSummaryView();
        this.initClassManagementView();

        // 初期表示をセット
        this.switchView('attendance-input');

        // Check for returning IDB persistent file handle OR GitHub sync settings
        const storedHandle = await this.storage.loadStoredFileHandle();
        const startupModal = document.getElementById('modal-startup');
        
        // Auto-login logic disabled per user request: Always show device selection first
        document.getElementById('startup-device-selection').style.display = 'block';
        document.getElementById('startup-options-pc').style.display = 'none';
        
        const loadingEl = document.getElementById('startup-loading');
        if(loadingEl) loadingEl.style.display = 'none';

        startupModal.classList.add('active');

        if (storedHandle) {
            const hasFileEl = document.getElementById('startup-has-file');
            if (hasFileEl) {
                hasFileEl.style.display = 'block';
                document.getElementById('startup-filename-text').textContent = storedHandle.name;
            }
        } else {
            const hasFileEl = document.getElementById('startup-has-file');
            if (hasFileEl) hasFileEl.style.display = 'none';
        }
    }

    refreshAllViews() {
        this.renderCalendar();
        this.refreshClassSelects('summary-class-select');
        this.refreshClassSelects('att-edit-class');
        this.renderClassesGrid();

        // Ensure to close any active editor modals
        document.getElementById('modal-attendance-editor').classList.remove('active');
        document.getElementById('modal-class-editor').classList.remove('active');
        document.getElementById('modal-summary-detail').classList.remove('active');

        // Reset summary table visually
        const summaryTbody = document.getElementById('summary-table-body');
        if (summaryTbody) {
            summaryTbody.innerHTML = '<tr><td colspan="7" class="empty-message">集計条件を指定して「集計」ボタンを押してください</td></tr>';
            document.getElementById('summary-total-classes').textContent = '0回';
        }
    }

    handleSyncStatusUpdate(status, filename = null) {
        const dots = [document.getElementById('sync-dot'), document.getElementById('mobile-sync-dot')];
        const texts = [document.getElementById('sync-text'), document.getElementById('mobile-sync-text')];

        const updateElements = (textStr, addClass) => {
            dots.forEach(dot => {
                if(dot) {
                    dot.className = 'status-dot'; // reset
                    dot.classList.add(addClass);
                }
            });
            texts.forEach(text => {
                if(text) text.textContent = textStr;
            });
        };

        switch (status) {
            case 'disconnected':
                updateElements('未接続 (ブラウザ保存のみ)', 'disconnected');
                break;
            case 'syncing':
                updateElements('同期中...', 'syncing');
                break;
            case 'synced':
                updateElements(filename ? `${filename} と同期中` : 'ファイルと同期済み', 'synced');
                break;
            case 'error':
                updateElements('ファイル保存エラー', 'error');
                break;
        }
    }

    showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    //------------------------------------------
    // Navigation & Globals
    //------------------------------------------
    setupNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                navItems.forEach(n => n.classList.remove('active'));
                item.classList.add('active');
                this.switchView(item.dataset.view);
            });
        });
    }

    setupGlobals() {
        // Modal close buttons
        document.querySelectorAll('.btn-close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetId = e.currentTarget.dataset.target;
                if (targetId) {
                    document.getElementById(targetId).classList.remove('active');
                }
            });
        });

        // File System API Controls (Sidebar)
        document.getElementById('btn-fs-new').addEventListener('click', async () => {
            if (await this.storage.createNewFile()) {
                this.showToast('新しいファイルを作成し、同期を開始しました');
                this.refreshAllViews();
            }
        });

        document.getElementById('btn-fs-open').addEventListener('click', async () => {
            if (await this.storage.openExistingFile()) {
                this.showToast('ファイルを読み込み、同期を開始しました');
                this.refreshAllViews();
            }
        });

        // Startup Modal Logic
        document.getElementById('btn-startup-resume').addEventListener('click', async () => {
            if (await this.storage.reloadStoredFile()) {
                document.getElementById('modal-startup').classList.remove('active');
                this.refreshAllViews();
                this.showToast('ファイルからデータを読み込み、同期を再開しました');
            } else {
                alert('ファイルの読み込みに失敗したか、アクセスが拒否されました。\n別のファイルを作成または開いてください。');
                document.getElementById('startup-has-file').style.display = 'none';
            }
        });

        document.getElementById('btn-startup-new').addEventListener('click', async () => {
            if (await this.storage.createNewFile()) {
                document.getElementById('modal-startup').classList.remove('active');
                this.refreshAllViews();
                this.showToast('新しいファイルを作成し、同期を開始しました');
            }
        });

        document.getElementById('btn-startup-open').addEventListener('click', async () => {
            if (await this.storage.openExistingFile()) {
                document.getElementById('modal-startup').classList.remove('active');
                this.refreshAllViews();
                this.showToast('ファイルを読み込み、同期を開始しました');
            }
        });

        const btnBrowserOnly = document.getElementById('btn-startup-browser-only');
        if (btnBrowserOnly) {
            btnBrowserOnly.addEventListener('click', () => {
                document.getElementById('modal-startup').classList.remove('active');
                this.refreshAllViews();
                this.storage.updateSyncStatus('disconnected');
                this.showToast('ブラウザ保存モードで開始しました。データは定期的に出力してください。');
            });
        }
        
        // GitHub API Settings Modal Logic
        const openGitHubSettings = () => {
            document.getElementById('gh-setting-owner').value = this.storage.ghSettings.owner || '';
            document.getElementById('gh-setting-repo').value = this.storage.ghSettings.repo || '';
            document.getElementById('gh-setting-path').value = this.storage.ghSettings.path || 'data.json';
            document.getElementById('gh-setting-token').value = this.storage.ghSettings.token || '';
            document.getElementById('gh-sync-test-result').textContent = '';
            
            document.getElementById('modal-github-settings').classList.add('active');
        };

        // Device Selection Flow
        document.getElementById('btn-startup-select-mobile').addEventListener('click', () => {
            // Show settings explicitly for mobile
            document.getElementById('nav-settings-mobile').style.display = 'flex';
            openGitHubSettings();
        });

        document.getElementById('btn-startup-select-pc').addEventListener('click', () => {
            document.getElementById('startup-device-selection').style.display = 'none';
            document.getElementById('startup-options-pc').style.display = 'block';
            document.getElementById('startup-modal-title').textContent = '💻 パソコン用設定';
        });

        document.getElementById('btn-startup-back-to-device').addEventListener('click', () => {
            document.getElementById('startup-options-pc').style.display = 'none';
            document.getElementById('startup-device-selection').style.display = 'block';
            document.getElementById('startup-modal-title').textContent = '利用する端末の選択';
        });

        const btnStartupGithubPc = document.getElementById('btn-startup-github-sync-pc');
        if (btnStartupGithubPc) {
            btnStartupGithubPc.addEventListener('click', openGitHubSettings);
        }
        
        // Mobile settings view buttons
        const btnMobileGitHub = document.getElementById('btn-mobile-github-sync');
        if (btnMobileGitHub) {
            btnMobileGitHub.addEventListener('click', openGitHubSettings);
        }

        const btnMobileGitHubPull = document.getElementById('btn-mobile-github-pull');
        if (btnMobileGitHubPull) {
            btnMobileGitHubPull.addEventListener('click', async () => {
                if (!this.storage.ghSettings.enabled || !this.storage.ghSettings.token) {
                    alert('まずはクラウド連携の設定を行ってください。');
                    return;
                }
                
                if (confirm('クラウド上の最新データで現在の表示を上書きしますか？未保存の編集データは失われます。')) {
                    if (await this.storage.loadDataFromGitHub()) {
                        this.refreshAllViews();
                        this.showToast('クラウドから最新データを強制取得しました');
                    } else {
                        alert('クラウドからのデータ取得に失敗しました。');
                    }
                }
            });
        }

        document.getElementById('btn-gh-test-conn').addEventListener('click', async () => {
            const owner = document.getElementById('gh-setting-owner').value.trim();
            const repo = document.getElementById('gh-setting-repo').value.trim();
            const path = document.getElementById('gh-setting-path').value.trim();
            const token = document.getElementById('gh-setting-token').value.trim();
            const resultDiv = document.getElementById('gh-sync-test-result');

            if (!owner || !repo || !path || !token) {
                resultDiv.innerHTML = '<span style="color:#f87171">すべての項目を入力してください。</span>';
                return;
            }

            resultDiv.innerHTML = 'テスト中...';
            const res = await this.storage.testGitHubConnection(owner, repo, path, token);
            
            if (res.success) {
                resultDiv.innerHTML = `<span style="color:#34d399">✅ ${res.message}</span>`;
            } else {
                resultDiv.innerHTML = `<span style="color:#f87171">❌ ${res.message}</span>`;
            }
        });

        document.getElementById('btn-gh-save-settings').addEventListener('click', async () => {
            const owner = document.getElementById('gh-setting-owner').value.trim();
            const repo = document.getElementById('gh-setting-repo').value.trim();
            const path = document.getElementById('gh-setting-path').value.trim();
            const token = document.getElementById('gh-setting-token').value.trim();

            if (!owner || !repo || !path || !token) {
                alert('すべての項目を入力してください。');
                return;
            }

            // Save and enable
            this.storage.saveGitHubSettings({
                owner, repo, path, token, enabled: true
            });

            document.getElementById('modal-github-settings').classList.remove('active');
            document.getElementById('modal-startup').classList.remove('active');
            
            // Initiate sync
            if (await this.storage.loadDataFromGitHub()) {
                this.refreshAllViews();
                this.showToast('GitHubからデータを同期し、設定を保存しました');
            } else {
                // Attempt to save data if new file
                if (await this.storage.saveDataToGitHub()) {
                    this.refreshAllViews();
                    this.showToast('GitHubに新規ファイルを作成して同期を開始しました');
                } else {
                    alert('同期に失敗しました。設定を見直してください。');
                    this.storage.saveGitHubSettings({ enabled: false });
                    document.getElementById('modal-startup').classList.add('active');
            }
        });

        document.getElementById('btn-gh-create-new').addEventListener('click', async () => {
            const owner = document.getElementById('gh-setting-owner').value.trim();
            const repo = document.getElementById('gh-setting-repo').value.trim();
            const path = document.getElementById('gh-setting-path').value.trim();
            const token = document.getElementById('gh-setting-token').value.trim();

            if (!owner || !repo || !path || !token) {
                alert('すべての項目を入力してください。');
                return;
            }

            if (!confirm(`本当に「${path}」という空のファイルをGitHubに新規作成しますか？`)) {
                return;
            }

            try {
                // 1. Check if file already exists to prevent overwrite
                const checkUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
                const checkRes = await fetch(checkUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `token ${token}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                });

                if (checkRes.ok) {
                    alert('エラー：そのファイルパスは既に存在します。上書きを防ぐため中止しました。既存ファイルと同期する場合は「保存して同期開始」を選んでください。');
                    return;
                }

                if (checkRes.status !== 404) {
                    throw new Error(`GitHub API エラー: ${checkRes.status} ${checkRes.statusText}`);
                }

                // 2. File doesn't exist (404), so create it
                const emptyData = { classes: [], attendance: {} };
                const contentStr = JSON.stringify(emptyData, null, 2);
                const contentBase64 = btoa(unescape(encodeURIComponent(contentStr)));

                const createRes = await fetch(checkUrl, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: 'feat: initialize new attendance data file',
                        content: contentBase64
                    })
                });

                if (!createRes.ok) {
                    throw new Error(`ファイル作成に失敗しました: ${createRes.status}`);
                }

                // 3. Success -> Save settings and initialize app
                this.storage.saveGitHubSettings({ owner, repo, path, token, enabled: true });
                document.getElementById('modal-github-settings').classList.remove('active');
                document.getElementById('modal-startup').classList.remove('active');
                
                await this.storage.loadDataFromGitHub();
                this.refreshAllViews();
                this.showToast('🚀 GitHubに新規ファイルを作成し、同期を開始しました！');

            } catch (error) {
                console.error('Error creating new GitHub file:', error);
                alert('エラーが発生しました: ' + error.message);
            }
        });
        
        // ファイル操作APIが非対応の環境（スマホなど）の処理
        const isFSSupported = 'showOpenFilePicker' in window;
        if (!isFSSupported || window.innerWidth <= 768) {
            // Show settings tab on mobile explicitly
            document.getElementById('nav-settings-mobile').style.display = 'flex';
        }
        
        if (!isFSSupported) {
            // サイドバーのボタンを非表示
            const btnFsNew = document.getElementById('btn-fs-new');
            const btnFsOpen = document.getElementById('btn-fs-open');
            if (btnFsNew) btnFsNew.style.display = 'none';
            if (btnFsOpen) btnFsOpen.style.display = 'none';
            
            // モーダルのボタンを非表示
            const btnStartupNew = document.getElementById('btn-startup-new');
            const btnStartupOpen = document.getElementById('btn-startup-open');
            if (btnStartupNew) btnStartupNew.style.display = 'none';
            if (btnStartupOpen) btnStartupOpen.style.display = 'none';
            
            // モーダルの説明文を変更
            const startupDesc = document.getElementById('startup-desc-text');
            if (startupDesc) {
                startupDesc.innerHTML = 'お使いのブラウザ（スマートフォンや未対応環境）はファイル直接同期に非対応です。<br><small>「クラウドと同期」または「ブラウザのみ」を選択してください。</small>';
            }
        }

        const fileInput = document.getElementById('file-import');
        const handleImport = () => fileInput.click();
        const handleExport = () => {
            this.storage.exportData();
            this.showToast('データをエクスポートしました');
        };

        // Export/Import (Fallback) desktop
        document.getElementById('btn-export').addEventListener('click', handleExport);
        document.getElementById('btn-import').addEventListener('click', handleImport);

        // Export/Import mobile
        const btnMobileExport = document.getElementById('btn-mobile-export');
        const btnMobileImport = document.getElementById('btn-mobile-import');
        if (btnMobileExport) btnMobileExport.addEventListener('click', handleExport);
        if (btnMobileImport) btnMobileImport.addEventListener('click', handleImport);

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (event) => {
                    const success = this.storage.importData(event.target.result);
                    if (success) {
                        this.showToast('データをインポートしました');
                        window.location.reload(); // リロードして状態をリセット
                    } else {
                        alert('不正なファイル形式です。');
                    }
                };
                reader.readAsText(file);
            }
        });
    }

    switchView(viewName) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const newView = document.getElementById(`view-${viewName}`);
        if (newView) newView.classList.add('active');

        // ビュー切り替え時のフック
        if (viewName === 'attendance-input') {
            this.renderCalendar();
        } else if (viewName === 'attendance-summary') {
            this.refreshClassSelects('summary-class-select');
        } else if (viewName === 'class-management') {
            this.renderClassesGrid();
        }
    }

    refreshClassSelects(selectId) {
        const select = document.getElementById(selectId);
        const currentVal = select.value;
        select.innerHTML = '<option value="">クラスを選択してください</option>';

        this.storage.data.classes.forEach(c => {
            const option = document.createElement('option');
            option.value = c.id;
            option.textContent = c.name;
            select.appendChild(option);
        });

        if (currentVal && this.storage.data.classes.find(c => c.id === currentVal)) {
            select.value = currentVal;
            select.dispatchEvent(new Event('change'));
        }
    }

    //------------------------------------------
    // 1. Attendance Input View (Calendar UI)
    //------------------------------------------
    initAttendanceInputView() {
        document.getElementById('btn-prev-month').addEventListener('click', () => {
            this.calendarDate.setMonth(this.calendarDate.getMonth() - 1);
            this.renderCalendar();
        });

        document.getElementById('btn-next-month').addEventListener('click', () => {
            this.calendarDate.setMonth(this.calendarDate.getMonth() + 1);
            this.renderCalendar();
        });

        document.getElementById('btn-today-month').addEventListener('click', () => {
            this.calendarDate = new Date();
            this.renderCalendar();
        });

        // Attendance Editor Modal Logic
        const classSelect = document.getElementById('att-edit-class');
        classSelect.addEventListener('change', () => this.renderAttendanceEditorTable());

        document.getElementById('btn-save-attendance').addEventListener('click', () => this.saveAttendanceFromModal());
        document.getElementById('btn-delete-attendance').addEventListener('click', () => this.deleteAttendanceEntry());

        // Daily Classes Modal New Button
        const btnDailyAddNew = document.getElementById('btn-daily-add-new');
        if (btnDailyAddNew) {
            btnDailyAddNew.addEventListener('click', () => {
                document.getElementById('modal-daily-classes').classList.remove('active');
                this.openAttendanceModal(this.calendarDateSelected, null);
            });
        }
    }

    renderCalendar() {
        const year = this.calendarDate.getFullYear();
        const month = this.calendarDate.getMonth();

        document.getElementById('calendar-month-title').textContent = `${year}年 ${month + 1}月`;

        const body = document.getElementById('calendar-body');
        body.innerHTML = '';

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);

        const startOffset = firstDay.getDay(); // Sunday = 0
        const totalCells = Math.ceil((startOffset + lastDay.getDate()) / 7) * 7;

        const todayStr = getTodayString();

        for (let i = 0; i < totalCells; i++) {
            const currentCellDate = new Date(year, month, i - startOffset + 1);
            const dateStr = formatDateStr(currentCellDate.getFullYear(), currentCellDate.getMonth() + 1, currentCellDate.getDate());

            const cell = document.createElement('div');
            cell.className = 'calendar-cell';
            if (currentCellDate.getMonth() !== month) cell.classList.add('other-month');
            if (dateStr === todayStr) cell.classList.add('today');

            // Add weekend classes for styling
            const dayOfWeek = currentCellDate.getDay();
            if (dayOfWeek === 0) cell.classList.add('sunday');
            if (dayOfWeek === 6) cell.classList.add('saturday');

            // Top section: Date number and + button
            const cellTop = document.createElement('div');
            cellTop.className = 'cell-top';
            cellTop.style.cursor = 'pointer'; // Make it obvious it's clickable
            cellTop.innerHTML = `
                <span class="cell-date">${currentCellDate.getDate()}</span>
                <button class="btn-add-attendance" title="出欠を登録する" data-date="${dateStr}">+</button>
            `;
            
            // Allow tapping the date number area to add attendance (especially for mobile where + is hidden)
            // Allow tapping the date number area (or cell) to open the daily menu 
            cellTop.addEventListener('click', () => {
                this.openDailyClassesModal(dateStr);
            });
            
            cell.appendChild(cellTop);

            // Badges section
            const badgesContainer = document.createElement('div');
            badgesContainer.className = 'cell-badges';

            const dailyData = this.storage.data.attendance[dateStr];
            if (dailyData) {
                // PERIODSの順でソートして表示
                PERIODS.forEach(period => {
                    if (dailyData[period]) {
                        const classData = dailyData[period];
                        const cls = this.storage.data.classes.find(c => c.id === classData.classId);
                        const className = cls ? cls.name : '不明なクラス';

                        const classIndex = this.storage.data.classes.findIndex(c => c.id === classData.classId);

                        const badge = document.createElement('div');
                        badge.className = 'attendance-badge';
                        badge.textContent = `${period}: ${className}`;
                        badge.dataset.date = dateStr;
                        badge.dataset.period = period;
                        badge.dataset.colorIndex = classIndex >= 0 ? classIndex % 8 : 0; // consistent color by class
                        badge.title = `${period}: ${className} (クリックして編集)`;

                        badge.addEventListener('click', (e) => {
                            e.stopPropagation(); // Avoid triggering cell top click if they somehow click this directly
                            this.openAttendanceModal(dateStr, period);
                        });

                        badgesContainer.appendChild(badge);
                    }
                });
            }

            cell.appendChild(badgesContainer);
            body.appendChild(cell);
        }

        // Event for + buttons
        // Event for + buttons (still present on desktop)
        document.querySelectorAll('.btn-add-attendance').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openDailyClassesModal(e.currentTarget.dataset.date);
            });
        });
    }

    openDailyClassesModal(dateStr) {
        this.calendarDateSelected = dateStr;
        const [year, month, day] = dateStr.split('-');
        
        document.getElementById('daily-classes-title').textContent = `📅 ${parseInt(month)}月 ${parseInt(day)}日のクラス`;
        
        const listContainer = document.getElementById('daily-classes-list');
        listContainer.innerHTML = '';
        
        const dailyData = this.storage.data.attendance[dateStr];
        let hasClasses = false;

        if (dailyData) {
            PERIODS.forEach(period => {
                if (dailyData[period]) {
                    hasClasses = true;
                    const classData = dailyData[period];
                    const classIndex = this.storage.data.classes.findIndex(c => c.id === classData.classId);
                    const cls = this.storage.data.classes.find(c => c.id === classData.classId);
                    const className = cls ? cls.name : '不明なクラス';
                    
                    const btn = document.createElement('button');
                    // Add a tiny colored dot next to the class name to match the calendar
                    const dotColorIndex = classIndex >= 0 ? classIndex % 8 : 0;
                    
                    btn.className = 'btn btn-outline';
                    btn.style.width = '100%';
                    btn.style.textAlign = 'left';
                    btn.style.padding = '14px';
                    btn.style.display = 'flex';
                    btn.style.justifyContent = 'space-between';
                    
                    btn.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="attendance-badge-inline" data-color-index="${dotColorIndex}" style="width: 12px; height: 12px; border-radius: 50%; display: inline-block;"></span>
                            <span style="font-weight: bold;">${period}</span>
                            <span>${className}</span>
                        </div>
                        <span style="color: var(--text-muted); font-size: 0.8rem;">✏️ 編集</span>
                    `;
                    
                    btn.addEventListener('click', () => {
                        document.getElementById('modal-daily-classes').classList.remove('active');
                        this.openAttendanceModal(dateStr, period);
                    });
                    
                    listContainer.appendChild(btn);
                }
            });
        }
        
        if (!hasClasses) {
            listContainer.innerHTML = '<div style="text-align:center; padding: 20px 0; color: var(--text-muted);">まだ登録されていません</div>';
        }

        document.getElementById('modal-daily-classes').classList.add('active');
    }

    openAttendanceModal(dateStr, originalPeriod) {
        this.attEditingDate = dateStr;
        this.attEditingOriginalPeriod = originalPeriod;

        document.getElementById('att-edit-date').value = dateStr;
        this.refreshClassSelects('att-edit-class');

        const periodSelect = document.getElementById('att-edit-period');
        const classSelect = document.getElementById('att-edit-class');
        const btnDelete = document.getElementById('btn-delete-attendance');

        if (originalPeriod) {
            // Edit mode
            const dailyData = this.storage.data.attendance[dateStr];
            const periodData = dailyData[originalPeriod];

            periodSelect.value = originalPeriod;
            classSelect.value = periodData.classId;
            btnDelete.style.display = 'block';
        } else {
            // Create mode
            periodSelect.value = '1限';
            classSelect.value = '';
            btnDelete.style.display = 'none';
        }

        this.renderAttendanceEditorTable();
        document.getElementById('modal-attendance-editor').classList.add('active');
    }

    renderAttendanceEditorTable() {
        const classId = document.getElementById('att-edit-class').value;
        const tbody = document.getElementById('att-edit-tbody');
        const saveBtn = document.getElementById('btn-save-attendance');

        if (!classId) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-message">クラスを選択してください</td></tr>';
            saveBtn.disabled = true;
            return;
        }

        const cls = this.storage.data.classes.find(c => c.id === classId);
        if (!cls) return;

        const students = [...cls.students].sort((a, b) => a.number - b.number);

        // 既存データの取得（編集時、同じ時限・クラスの場合のみ復元する）
        const periodStr = document.getElementById('att-edit-period').value;
        let existingRecords = {};

        // 既存の時限のデータと同じ時限・クラスを開いているなら復元
        if (this.attEditingOriginalPeriod &&
            this.attEditingOriginalPeriod === periodStr &&
            this.storage.data.attendance[this.attEditingDate]?.[periodStr]?.classId === classId) {
            existingRecords = this.storage.data.attendance[this.attEditingDate][periodStr].records || {};
        }

        tbody.innerHTML = '';
        let hasInputtable = false;

        students.forEach(student => {
            const tr = document.createElement('tr');

            let statusClass = 'status-normal';
            if (student.status === STUDENT_STATUS.TRANSFER) statusClass = 'status-transfer';
            if (student.status === STUDENT_STATUS.DROPOUT) statusClass = 'status-dropout';
            if (student.status === STUDENT_STATUS.LONG_ABSENT) statusClass = 'status-longabsent';

            const isExcluded = student.status === STUDENT_STATUS.TRANSFER || student.status === STUDENT_STATUS.DROPOUT;

            let optionsHtml = '';
            if (isExcluded) {
                // 入力不可とする
                tr.classList.add('row-disabled');
                optionsHtml = `<span class="excluded-label">出欠確認の対象外です</span>`;
            } else {
                hasInputtable = true;

                // 長期欠席の場合はデフォルトを欠席にする。それ以外は出席か、既存データ。
                let defaultVal = ATTENDANCE_TYPES.PRESENT;
                if (student.status === STUDENT_STATUS.LONG_ABSENT) {
                    defaultVal = ATTENDANCE_TYPES.ABSENT;
                }
                const currentStatus = existingRecords[student.id] || defaultVal;

                optionsHtml = '<div class="attendance-options">';
                Object.values(ATTENDANCE_TYPES).forEach(type => {
                    const isChecked = currentStatus === type ? 'checked' : '';
                    optionsHtml += `
                        <input type="radio" name="att_edit_${student.id}" id="att_edit_${student.id}_${type}" value="${type}" class="attendance-radio" ${isChecked}>
                        <label for="att_edit_${student.id}_${type}" class="attendance-label" data-type="${type}">${type}</label>
                    `;
                });
                optionsHtml += '</div>';
            }

            tr.innerHTML = `
                <td>${student.number}</td>
                <td>${student.name}</td>
                <td><span class="status-badge ${statusClass}">${student.status}</span></td>
                <td>${optionsHtml}</td>
            `;
            tbody.appendChild(tr);
        });

        saveBtn.disabled = !hasInputtable;
    }

    saveAttendanceFromModal() {
        const dateStr = this.attEditingDate;
        const periodStr = document.getElementById('att-edit-period').value;
        const classId = document.getElementById('att-edit-class').value;

        if (!classId) return;

        // 重複チェック
        if (this.storage.data.attendance[dateStr]?.[periodStr]) {
            // 新規作成時、または編集だが対象時限を変更しようとした時に、移動先が埋まっている場合
            if (!this.attEditingOriginalPeriod || this.attEditingOriginalPeriod !== periodStr) {
                alert(`エラー：${dateStr} の ${periodStr} には既に別のクラスが登録されています。`);
                return;
            }
        }

        const cls = this.storage.data.classes.find(c => c.id === classId);
        if (!cls) return;

        if (!this.storage.data.attendance[dateStr]) {
            this.storage.data.attendance[dateStr] = {};
        }

        // もし編集で時限が変わった場合、古い時限を削除
        if (this.attEditingOriginalPeriod && this.attEditingOriginalPeriod !== periodStr) {
            delete this.storage.data.attendance[dateStr][this.attEditingOriginalPeriod];
        }

        // 保存用オブジェクトの構築
        const records = {};
        let savedCount = 0;

        cls.students.forEach(student => {
            const isExcluded = student.status === STUDENT_STATUS.TRANSFER || student.status === STUDENT_STATUS.DROPOUT;
            if (!isExcluded) {
                const selected = document.querySelector(`input[name="att_edit_${student.id}"]:checked`);
                if (selected) {
                    records[student.id] = selected.value;
                    savedCount++;
                }
            }
        });

        this.storage.data.attendance[dateStr][periodStr] = {
            classId: classId,
            records: records
        };

        this.storage.saveData().then(() => {
            document.getElementById('modal-attendance-editor').classList.remove('active');
            this.renderCalendar();
            this.showToast(`${dateStr} ${periodStr} のデータを保存しました`);
        });
    }

    deleteAttendanceEntry() {
        if (!this.attEditingDate || !this.attEditingOriginalPeriod) return;

        if (confirm('この時限の出欠データを削除してもよろしいですか？')) {
            if (this.storage.data.attendance[this.attEditingDate] &&
                this.storage.data.attendance[this.attEditingDate][this.attEditingOriginalPeriod]) {

                delete this.storage.data.attendance[this.attEditingDate][this.attEditingOriginalPeriod];

                // 日付自体が空になればキーを消す
                if (Object.keys(this.storage.data.attendance[this.attEditingDate]).length === 0) {
                    delete this.storage.data.attendance[this.attEditingDate];
                }

                this.storage.saveData().then(() => {
                    document.getElementById('modal-attendance-editor').classList.remove('active');
                    this.renderCalendar();
                    this.showToast('データを削除しました');
                });
            }
        }
    }

    //------------------------------------------
    // 2. Attendance Summary View
    //------------------------------------------
    initAttendanceSummaryView() {
        const startDateInput = document.getElementById('summary-start-date');
        const endDateInput = document.getElementById('summary-end-date');
        const btnCalc = document.getElementById('btn-calculate-summary');

        // デフォルトは当月1日〜末日
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        startDateInput.value = formatDateStr(firstDay.getFullYear(), firstDay.getMonth() + 1, firstDay.getDate());
        endDateInput.value = formatDateStr(lastDay.getFullYear(), lastDay.getMonth() + 1, lastDay.getDate());

        btnCalc.addEventListener('click', () => {
            const startStr = startDateInput.value;
            const endStr = endDateInput.value;
            const classId = document.getElementById('summary-class-select').value;
            const tbody = document.getElementById('summary-table-body');
            const totalClassesEl = document.getElementById('summary-total-classes');

            this.summaryDetailsData = {}; // reset details

            if (!startStr || !endStr || !classId) {
                this.showToast("期間とクラスを正しく指定してください");
                return;
            }

            const cls = this.storage.data.classes.find(c => c.id === classId);
            if (!cls) return;

            // 対象日付リストを取得
            const targetDates = Object.keys(this.storage.data.attendance).filter(date => {
                return date >= startStr && date <= endStr;
            });

            // 集計オブジェクト初期化
            const counts = {};
            let totalClasses = 0;

            cls.students.forEach(s => {
                const isExcluded = s.status === STUDENT_STATUS.TRANSFER || s.status === STUDENT_STATUS.DROPOUT;
                counts[s.id] = {
                    isExcluded: isExcluded,
                    [ATTENDANCE_TYPES.PRESENT]: 0,
                    [ATTENDANCE_TYPES.ABSENT]: 0,
                    [ATTENDANCE_TYPES.SUSPEND]: 0,
                    [ATTENDANCE_TYPES.OFFICIAL]: 0,
                    [ATTENDANCE_TYPES.MOURNING]: 0,
                    details: {
                        [ATTENDANCE_TYPES.ABSENT]: [],
                        [ATTENDANCE_TYPES.SUSPEND]: [],
                        [ATTENDANCE_TYPES.OFFICIAL]: [],
                        [ATTENDANCE_TYPES.MOURNING]: []
                    }
                };
            });

            // 集計
            targetDates.forEach(date => {
                const dailyData = this.storage.data.attendance[date];
                if (dailyData) {
                    PERIODS.forEach(period => {
                        const periodData = dailyData[period];
                        if (periodData && periodData.classId === classId) {
                            totalClasses++; // 指定クラスの授業とみなす

                            Object.keys(periodData.records).forEach(studentId => {
                                const status = periodData.records[studentId];
                                if (counts[studentId] && counts[studentId][status] !== undefined && !counts[studentId].isExcluded) {
                                    counts[studentId][status]++;

                                    // 詳細のリストを保存（出席以外）
                                    if (status !== ATTENDANCE_TYPES.PRESENT) {
                                        counts[studentId].details[status].push(`${date} ${period}`);
                                    }
                                }
                            });
                        }
                    });
                }
            });

            totalClassesEl.textContent = `${totalClasses}回`;

            // 描画
            tbody.innerHTML = '';
            const students = [...cls.students].sort((a, b) => a.number - b.number);

            if (students.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-message">生徒が登録されていません</td></tr>';
                return;
            }

            students.forEach(student => {
                const c = counts[student.id];
                const tr = document.createElement('tr');

                if (c.isExcluded) {
                    tr.classList.add('row-disabled');
                    tr.innerHTML = `
                        <td>${student.number}</td>
                        <td>${student.name}</td>
                        <td colspan="5" class="excluded-label" style="text-align:center;">対象外（${student.status}）</td>
                    `;
                    tbody.appendChild(tr);
                    return;
                }

                // 欠席等の数値をフォーマット
                const formatCount = (type, count) => {
                    if (count > 0 && type !== ATTENDANCE_TYPES.PRESENT) {
                        const key = `${student.id}_${type}`;
                        this.summaryDetailsData[key] = c.details[type]; // モーダル表示用にグローバル保存
                        return `<span class="clickable-count" data-sid="${student.id}" data-type="${type}" data-name="${student.name}">${count}</span>`;
                    }
                    return count;
                };

                const studentTotal = c[ATTENDANCE_TYPES.PRESENT] + c[ATTENDANCE_TYPES.ABSENT] + c[ATTENDANCE_TYPES.SUSPEND] + c[ATTENDANCE_TYPES.OFFICIAL] + c[ATTENDANCE_TYPES.MOURNING];
                if (studentTotal !== totalClasses) {
                    tr.classList.add('mismatch-row');
                    tr.title = `出欠合計(${studentTotal}回) と 授業数(${totalClasses}回) が一致しません`;
                }

                tr.innerHTML = `
                    <td>${student.number}</td>
                    <td>${student.name}</td>
                    <td>${c[ATTENDANCE_TYPES.PRESENT]}</td>
                    <td>${formatCount(ATTENDANCE_TYPES.ABSENT, c[ATTENDANCE_TYPES.ABSENT])}</td>
                    <td>${formatCount(ATTENDANCE_TYPES.SUSPEND, c[ATTENDANCE_TYPES.SUSPEND])}</td>
                    <td>${formatCount(ATTENDANCE_TYPES.OFFICIAL, c[ATTENDANCE_TYPES.OFFICIAL])}</td>
                    <td>${formatCount(ATTENDANCE_TYPES.MOURNING, c[ATTENDANCE_TYPES.MOURNING])}</td>
                `;

                if (c[ATTENDANCE_TYPES.ABSENT] > 0) {
                    tr.children[3].style.color = 'var(--status-absent)';
                    tr.children[3].style.fontWeight = 'bold';
                }
                tbody.appendChild(tr);
            });

            // 詳細モーダルリスナー
            document.querySelectorAll('.clickable-count').forEach(el => {
                el.addEventListener('click', (e) => {
                    this.openSummaryDetailModal(
                        e.currentTarget.dataset.name,
                        e.currentTarget.dataset.type,
                        this.summaryDetailsData[`${e.currentTarget.dataset.sid}_${e.currentTarget.dataset.type}`]
                    );
                });
            });
        });
    }

    openSummaryDetailModal(studentName, type, detailsArray) {
        document.getElementById('summary-detail-title').textContent = `${studentName} さんの「${type}」一覧`;
        const listEl = document.getElementById('summary-detail-list');
        listEl.innerHTML = '';

        if (!detailsArray || detailsArray.length === 0) {
            listEl.innerHTML = '<li>データがありません</li>';
        } else {
            // "2026-02-26 1限" -> [ "2026-02-26", "1限" ]
            detailsArray.sort().forEach(item => {
                const parts = item.split(' ');
                const date = parts[0];
                const period = parts[1] || '';

                const li = document.createElement('li');
                li.innerHTML = `
                    <span class="detail-date">${date.replace(/-/g, '/')}</span>
                    <span class="detail-period">${period}</span>
                `;
                listEl.appendChild(li);
            });
        }

        document.getElementById('modal-summary-detail').classList.add('active');
    }

    //------------------------------------------
    // 3. Class Management View
    //------------------------------------------
    initClassManagementView() {
        document.getElementById('btn-add-class').addEventListener('click', () => {
            this.openClassModal(null); // null = 新規作成
        });

        document.getElementById('btn-add-student-row').addEventListener('click', () => {
            this.addStudentRowToModal();
        });

        document.getElementById('btn-save-class').addEventListener('click', () => {
            this.saveClassFromModal();
        });

        document.getElementById('btn-download-template').addEventListener('click', () => {
            this.downloadExcelTemplate();
        });

        const fileExcelInput = document.getElementById('file-import-excel');
        document.getElementById('btn-import-excel').addEventListener('click', () => {
            fileExcelInput.click();
        });

        fileExcelInput.addEventListener('change', (e) => {
            this.importExcelData(e);
        });
    }

    downloadExcelTemplate() {
        if (typeof XLSX === 'undefined') {
            alert('Excelライブラリが読み込まれていません。ネットワーク接続を確認してください。');
            return;
        }

        // テンプレートデータの作成
        const data = [
            ["出席番号", "氏名", "状態(通常/クラス移項/退学/長期欠席)"],
            [1, "生徒 山田", "通常"],
            [2, "生徒 鈴木", "通常"],
            [3, "生徒 佐藤", "長期欠席"]
        ];

        const ws = XLSX.utils.aoa_to_sheet(data);
        ws['!cols'] = [{ wch: 10 }, { wch: 20 }, { wch: 35 }]; // 列幅の調整

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "生徒登録テンプレート");

        XLSX.writeFile(wb, "Student_Template.xlsx");
    }

    importExcelData(e) {
        const file = e.target.files[0];
        if (!file) return;

        if (typeof XLSX === 'undefined') {
            alert('Excelライブラリが読み込まれていません。ネットワーク接続が必要です。');
            e.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = new Uint8Array(event.target.result);
                const workbook = XLSX.read(data, { type: 'array' });

                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];

                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                let importedCount = 0;
                for (let i = 1; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.length === 0 || !row[0]) continue;

                    const num = parseInt(row[0], 10);
                    const name = row[1] ? String(row[1]).trim() : '';
                    let status = row[2] ? String(row[2]).trim() : '通常';

                    if (!Object.values(STUDENT_STATUS).includes(status)) {
                        status = '通常';
                    }

                    if (num && name) {
                        this.addStudentRowToModal({ id: generateId(), number: num, name: name, status: status });
                        importedCount++;
                    }
                }

                this.showToast(`${importedCount}件の生徒データを読み込みました`);
            } catch (err) {
                console.error(err);
                alert('ファイルの読み込み中にエラーが発生しました。正しいExcelファイルか確認してください。');
            }
            e.target.value = ''; // Reset input
        };
        reader.readAsArrayBuffer(file);
    }

    renderClassesGrid() {
        const container = document.getElementById('classes-list');
        container.innerHTML = '';

        if (this.storage.data.classes.length === 0) {
            container.innerHTML = '<div class="empty-message" style="grid-column: 1/-1;">クラスが登録されていません。<br>「新規クラス」から作成してください。</div>';
            return;
        }

        this.storage.data.classes.forEach(cls => {
            const card = document.createElement('div');
            card.className = 'class-card';
            card.innerHTML = `
                <div class="class-card-header">
                    <h3 class="class-title">${cls.name}</h3>
                </div>
                <div class="class-stats">
                    生徒数: ${cls.students.length}名
                </div>
                <div class="class-actions">
                    <button class="btn btn-sm btn-outline btn-edit-class" data-id="${cls.id}">編集</button>
                    <button class="btn btn-sm btn-danger btn-delete-class" data-id="${cls.id}">削除</button>
                </div>
            `;
            container.appendChild(card);
        });

        // Add events
        document.querySelectorAll('.btn-edit-class').forEach(btn => {
            btn.addEventListener('click', (e) => this.openClassModal(e.target.dataset.id));
        });
        document.querySelectorAll('.btn-delete-class').forEach(btn => {
            btn.addEventListener('click', (e) => this.deleteClass(e.target.dataset.id));
        });
    }

    openClassModal(classId) {
        this.editingClassId = classId;
        const modal = document.getElementById('modal-class-editor');
        const title = document.getElementById('class-editor-title');
        const nameInput = document.getElementById('edit-class-name');
        const tbody = document.getElementById('student-edit-rows');

        tbody.innerHTML = '';

        if (classId) {
            const cls = this.storage.data.classes.find(c => c.id === classId);
            title.textContent = 'クラスの編集';
            nameInput.value = cls.name;

            const students = [...cls.students].sort((a, b) => a.number - b.number);
            students.forEach(s => this.addStudentRowToModal(s));
        } else {
            title.textContent = '新規クラスの作成';
            nameInput.value = '';
            this.addStudentRowToModal();
        }

        modal.classList.add('active');
    }

    addStudentRowToModal(student = null) {
        const tbody = document.getElementById('student-edit-rows');
        const tr = document.createElement('tr');

        const sId = student ? student.id : generateId();
        const sNum = student ? student.number : (tbody.children.length + 1);
        const sName = student ? student.name : '';
        const sStatus = student ? student.status : STUDENT_STATUS.NORMAL;

        const statusOptions = Object.values(STUDENT_STATUS).map(s =>
            `<option value="${s}" ${s === sStatus ? 'selected' : ''}>${s}</option>`
        ).join('');

        tr.innerHTML = `
            <td>
                <input type="number" class="student-number narrow-input" value="${sNum}" min="1" required data-id="${sId}">
            </td>
            <td>
                <input type="text" class="student-name narrow-input" value="${sName}" placeholder="氏名" required>
            </td>
            <td>
                <select class="student-status narrow-input">
                    ${statusOptions}
                </select>
            </td>
            <td>
                <button type="button" class="btn btn-sm btn-outline text-danger btn-remove-row">削除</button>
            </td>
        `;

        tr.querySelector('.btn-remove-row').addEventListener('click', () => {
            tr.remove();
        });

        tbody.appendChild(tr);
    }

    saveClassFromModal() {
        const nameInput = document.getElementById('edit-class-name').value.trim();
        if (!nameInput) {
            alert('クラス名を入力してください');
            return;
        }

        const rows = document.getElementById('student-edit-rows').querySelectorAll('tr');
        const students = [];

        let hasError = false;
        rows.forEach(row => {
            const numEl = row.querySelector('.student-number');
            const nameEl = row.querySelector('.student-name');
            const statusEl = row.querySelector('.student-status');

            const num = parseInt(numEl.value, 10);
            const name = nameEl.value.trim();
            const status = statusEl.value;
            const id = numEl.dataset.id;

            if (!num || !name) {
                hasError = true;
                return;
            }

            students.push({ id, number: num, name, status });
        });

        if (hasError) {
            alert('出席番号と氏名は必須です');
            return;
        }

        if (this.editingClassId) {
            const clsIndex = this.storage.data.classes.findIndex(c => c.id === this.editingClassId);
            if (clsIndex >= 0) {
                this.storage.data.classes[clsIndex].name = nameInput;
                this.storage.data.classes[clsIndex].students = students;
            }
        } else {
            this.storage.data.classes.push({
                id: generateId(),
                name: nameInput,
                students: students
            });
        }

        this.storage.saveData().then(() => {
            document.getElementById('modal-class-editor').classList.remove('active');
            this.renderClassesGrid();
            this.showToast('クラス情報を保存しました');
        });
    }

    deleteClass(classId) {
        if (confirm('本当にこのクラスを削除しますか？\n（関連する出欠データも表示できなくなります。）')) {
            this.storage.data.classes = this.storage.data.classes.filter(c => c.id !== classId);
            this.storage.saveData().then(() => {
                this.renderClassesGrid();
                this.showToast('クラスを削除しました');
            });
        }
    }
}

// 起動
document.addEventListener('DOMContentLoaded', () => {
    window.app = new UIController();
});
