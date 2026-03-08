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
        this.data = this.loadDataFromLocal(); // Backup/Default source
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

        // Check for returning IDB persistent file handle
        const storedHandle = await this.storage.loadStoredFileHandle();
        const startupModal = document.getElementById('modal-startup');

        if (storedHandle) {
            document.getElementById('startup-has-file').style.display = 'block';
            document.getElementById('startup-filename-text').textContent = storedHandle.name;
        } else {
            document.getElementById('startup-has-file').style.display = 'none';
        }

        // Show startup modal to enforce file selection
        startupModal.classList.add('active');
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
        const dot = document.getElementById('sync-dot');
        const text = document.getElementById('sync-text');

        dot.className = 'status-dot'; // reset

        switch (status) {
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = '未接続 (ブラウザ保存のみ)';
                break;
            case 'syncing':
                dot.classList.add('syncing');
                text.textContent = '同期中...';
                break;
            case 'synced':
                dot.classList.add('synced');
                text.textContent = filename ? `${filename} と同期中` : 'ファイルと同期済み';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'ファイル保存エラー';
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
        
        // ファイル操作APIが非対応の環境（スマホなど）の処理
        const isFSSupported = 'showOpenFilePicker' in window;
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
                startupDesc.innerHTML = 'お使いのブラウザ（スマートフォンや未対応環境）はファイル直接同期に非対応です。<br><small>「ブラウザのみで利用」を選択し、定期的にデータを「出力」からバックアップしてください。</small>';
            }
        }

        // Export/Import (Fallback)
        document.getElementById('btn-export').addEventListener('click', () => {
            this.storage.exportData();
            this.showToast('データをエクスポートしました');
        });

        const fileInput = document.getElementById('file-import');
        document.getElementById('btn-import').addEventListener('click', () => {
            fileInput.click();
        });

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

            // Top section: Date number and + button
            const cellTop = document.createElement('div');
            cellTop.className = 'cell-top';
            cellTop.innerHTML = `
                <span class="cell-date">${currentCellDate.getDate()}</span>
                <button class="btn-add-attendance" title="出欠を登録する" data-date="${dateStr}">+</button>
            `;
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

                        const badge = document.createElement('div');
                        badge.className = 'attendance-badge';
                        badge.textContent = `${period}: ${className}`;
                        badge.dataset.date = dateStr;
                        badge.dataset.period = period;
                        badge.title = `${period}: ${className} (クリックして編集)`;

                        badge.addEventListener('click', (e) => {
                            this.openAttendanceModal(e.currentTarget.dataset.date, e.currentTarget.dataset.period);
                        });

                        badgesContainer.appendChild(badge);
                    }
                });
            }

            cell.appendChild(badgesContainer);
            body.appendChild(cell);
        }

        // Event for + buttons
        document.querySelectorAll('.btn-add-attendance').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.openAttendanceModal(e.currentTarget.dataset.date, null);
            });
        });
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
