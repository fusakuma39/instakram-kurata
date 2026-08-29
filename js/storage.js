/**
 * 完全クラウド同期ストレージサービス (クラウドデータ最優先 & サムネイル軽量化 & UIノンブロッキング)
 */
class StorageService {
  constructor() {
    this.dbName = "EduRecordDB_Elementary";
    this.dbVersion = 3; // バージョンアップして古いゴミキャッシュを自動クリア
    this.db = null;
    this.userNameKey = "instaKuram_current_user";
    this.gradeHierarchyKey = "instaKuram_grade_hierarchy";
    
    this.gasUrl = "https://script.google.com/macros/s/AKfycbwhuqZlEyHPRlcslldS_SSLvsMLZ7E3xHxybbwVuYnsUPpAf8iJGGcstO5yIlmGDnAx/exec";
  }

  // IndexedDBの初期化（UIの立ち上げを絶対にブロックしない設計）
  async init() {
    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(this.dbName, this.dbVersion);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (db.objectStoreNames.contains("records")) {
            db.deleteObjectStore("records");
          }
          const store = db.createObjectStore("records", { keyPath: "id" });
          store.createIndex("date", "date", { unique: false });
          store.createIndex("className", "className", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        };

        request.onsuccess = (event) => {
          this.db = event.target.result;
          resolve(this.db);
        };

        request.onerror = (event) => {
          console.error("IndexedDB open error:", event.target.error);
          resolve(null);
        };
      } catch (e) {
        console.warn("IndexedDB sync exception (third-party cookies disabled?):", e);
        resolve(null);
      }
    });
  }

  // Googleドライブの画像を軽量サムネイルURL（幅800px）へ変換
  formatDrivePhotoUrl(url) {
    if (!url) return "";
    const match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      const fileId = match[1];
      // 軽量・高速なサムネイルCDN（幅800px）
      return `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;
    }
    return url;
  }

  // クラウド（Googleスプレッドシート）のデータを最優先で同期し、端末内を上書き
  async syncFromCloud() {
    if (this.gasUrl) {
      try {
        const res = await fetch(this.gasUrl, { method: "GET" });
        if (res.ok) {
          const records = await res.json();
          if (Array.isArray(records)) {
            await this.clearLocalRecords();
            for (const rec of records) {
              if (rec && rec.id) {
                rec.photoUrl = this.formatDrivePhotoUrl(rec.photoUrl);
                await this.saveRecordLocal(rec);
              }
            }
            if (window.app && typeof window.app.refreshAllViews === "function") {
              window.app.refreshAllViews();
            }
          }
        }
      } catch (e) {
        console.warn("Fetch GET notice:", e);
      }
    }
  }

  // 端末内のローカルレコードを全クリア
  async clearLocalRecords() {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const transaction = this.db.transaction(["records"], "readwrite");
      const store = transaction.objectStore("records");
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  }

  // ユーザー名
  getCurrentUser() {
    try {
      return localStorage.getItem(this.userNameKey) || "";
    } catch (e) {
      console.warn("localStorage disabled", e);
      return "";
    }
  }

  setCurrentUser(name) {
    try {
      localStorage.setItem(this.userNameKey, name.trim());
    } catch (e) {
      console.warn("localStorage disabled", e);
    }
  }

  // 学年・クラス階層構造
  getGradeHierarchy() {
    try {
      const raw = localStorage.getItem(this.gradeHierarchyKey);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn(e);
    }
    return DEFAULT_GRADE_HIERARCHY;
  }

  saveGradeHierarchy(hierarchy) {
    try {
      localStorage.setItem(this.gradeHierarchyKey, JSON.stringify(hierarchy));
    } catch (e) {
      console.warn("localStorage disabled", e);
    }
  }

  getAllClassNames() {
    const hierarchy = this.getGradeHierarchy();
    const list = [];
    hierarchy.forEach(g => {
      if (g.classes && g.classes.length > 0) {
        list.push(...g.classes);
      }
    });
    return list;
  }

  async getAllRecords() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const transaction = this.db.transaction(["records"], "readonly");
      const store = transaction.objectStore("records");
      const request = store.getAll();

      request.onsuccess = () => {
        const records = request.result || [];
        records.forEach(r => {
          r.photoUrl = this.formatDrivePhotoUrl(r.photoUrl);
        });
        records.sort((a, b) => new Date(b.date + "T" + (b.createdAt ? b.createdAt.split("T")[1] : "00:00:00")) - new Date(a.date + "T" + (a.createdAt ? a.createdAt.split("T")[1] : "00:00:00")));
        resolve(records);
      };

      request.onerror = () => resolve([]);
    });
  }

  async getRecordById(id) {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      const transaction = this.db.transaction(["records"], "readonly");
      const store = transaction.objectStore("records");
      const request = store.get(id);
      request.onsuccess = () => {
        const rec = request.result;
        if (rec) rec.photoUrl = this.formatDrivePhotoUrl(rec.photoUrl);
        resolve(rec);
      };
      request.onerror = () => resolve(null);
    });
  }

  // 端末内IndexedDBへの保存
  async saveRecordLocal(record) {
    return new Promise((resolve) => {
      if (!this.db) return resolve(record);
      const transaction = this.db.transaction(["records"], "readwrite");
      const store = transaction.objectStore("records");
      const request = store.put(record);
      request.onsuccess = () => resolve(record);
      request.onerror = () => resolve(record);
    });
  }

  // 投稿の保存
  async saveRecord(record) {
    if (!record.id) {
      record.id = "rec_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    }
    if (!record.createdAt) {
      record.createdAt = new Date().toISOString();
    }
    if (!record.authorName) {
      record.authorName = this.getCurrentUser() || "先生";
    }
    if (!record.comments) {
      record.comments = [];
    }
    record.updatedAt = new Date().toISOString();

    // 1. まずローカルに即時保存
    await this.saveRecordLocal(record);

    // 2. クラウドへ送信
    this.sendToCloud(record).catch(err => console.warn("Cloud save error:", err));

    return record;
  }

  // Googleドライブ・スプレッドシートへ送信
  async sendToCloud(record) {
    if (this.gasUrl) {
      try {
        const payload = {
          id: record.id,
          authorName: record.authorName,
          date: record.date,
          className: record.className,
          image: record.photoUrl,
          filename: `${record.date}_${record.className}_${record.id}.jpg`,
          comment: record.comment,
          aspects: record.aspects || [],
          likes: record.likes || 0,
          comments: record.comments || [],
          createdAt: record.createdAt
        };

        const res = await fetch(this.gasUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const result = await res.json();
          if (result && result.photoUrl) {
            record.photoUrl = this.formatDrivePhotoUrl(result.photoUrl);
            await this.saveRecordLocal(record);
            if (window.app && typeof window.app.refreshAllViews === "function") {
              window.app.refreshAllViews();
            }
          }
        }
      } catch (err) {
        console.warn("Fetch POST notice:", err);
      }
    }
  }

  async addComment(recordId, text, authorName) {
    const record = await this.getRecordById(recordId);
    if (!record) return null;

    if (!record.comments) record.comments = [];
    const newComment = {
      id: "c_" + Date.now(),
      author: authorName || this.getCurrentUser() || "先生",
      text: text.trim(),
      createdAt: new Date().toISOString()
    };
    record.comments.push(newComment);
    await this.saveRecord(record);
    return record;
  }

  async deleteRecord(id) {
    return new Promise((resolve) => {
      if (!this.db) return resolve(true);
      const transaction = this.db.transaction(["records"], "readwrite");
      const store = transaction.objectStore("records");
      const request = store.delete(id);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(true);
    });
  }

  async toggleLike(id) {
    const record = await this.getRecordById(id);
    if (!record) return null;
    record.likes = (record.likes || 0) + 1;
    await this.saveRecord(record);
    return record;
  }

  async addReaction(id, emoji) {
    const record = await this.getRecordById(id);
    if (!record) return null;
    if (!record.reactions) record.reactions = [];
    record.reactions.push(emoji);
    await this.saveRecord(record);
    return record;
  }

  // ================= エクスポート =================

  async exportJson() {
    const records = await this.getAllRecords();
    const data = {
      app: "instaKuram",
      version: "6.0_cloud_priority",
      currentUser: this.getCurrentUser(),
      gradeHierarchy: this.getGradeHierarchy(),
      exportedAt: new Date().toISOString(),
      recordCount: records.length,
      records: records
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `insta倉m_小学校実践記録バックアップ_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async exportCsv() {
    const records = await this.getAllRecords();
    const headers = ["ID", "実施日", "学年学級", "投稿者", "一言コメント", "10の姿ハッシュタグ", "コメント数", "作成日時"];
    
    const rows = records.map(r => {
      const aspectNames = (r.aspects || []).map(id => {
        const aspect = TEN_ASPECTS.find(a => a.id === id);
        return aspect ? aspect.tag : id;
      }).join(" ");

      return [
        `"${r.id}"`,
        `"${r.date}"`,
        `"${r.className}"`,
        `"${r.authorName || ''}"`,
        `"${(r.comment || '').replace(/"/g, '""')}"`,
        `"${aspectNames}"`,
        `"${(r.comments || []).length}"`,
        `"${r.createdAt}"`
      ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `insta倉m_小学校実践一覧_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

window.storageService = new StorageService();
