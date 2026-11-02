/**
 * C 语言闯关营 · 核心同步与合并引擎 (sync-core.js)
 * 纯逻辑模块：白名单清洗、LWW 带墓碑合并、并发草稿保护、跨设备作答防重计数
 * 严格遵从 Supabase cquest_progress 契约与 2MB 限制
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CQuestSyncCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_DOCUMENT_BYTES = 2097152; // 2MB Supabase check limit
  const SCHEMA_VERSION = 1;

  // 安全检查：防止原型污染
  function isSafeKey(key) {
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }

  function getBytesLength(str) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(str, 'utf8');
    }
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length;
    }
    return unescape(encodeURIComponent(str)).length;
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function generateDeviceId() {
    return 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function normalizeDateStr(d) {
    if (typeof d !== 'string') return '';
    return /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : '';
  }

  /**
   * 创建初始空白云同步文档
   */
  function createBlankDocument(deviceId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(),
      deviceId: deviceId || generateDeviceId(),
      answers: {},
      wrong: {},
      favorites: {},
      levels: {},
      days: [],
      drafts: {},
      selfChecks: {}
    };
  }

  /**
   * 白名单清洗：仅保留答题、错题、收藏、关卡、天数、草稿、自评
   * 严格剔除 session、teaching、API key、token、密码、用户UUID及任意未授权字段
   */
  function sanitizeForCloud(rawDoc, options) {
    const opts = options || {};
    if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
      throw new Error('Invalid progress document: must be a JSON object');
    }

    const clean = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: typeof rawDoc.updatedAt === 'number' ? rawDoc.updatedAt : Date.now(),
      deviceId: typeof rawDoc.deviceId === 'string' ? rawDoc.deviceId.slice(0, 64) : (opts.deviceId || generateDeviceId()),
      answers: {},
      wrong: {},
      favorites: {},
      levels: {},
      days: [],
      drafts: {},
      selfChecks: {}
    };

    // 1. answers: [id] -> { attempts, correct, last, updatedAt, devices }
    if (rawDoc.answers && typeof rawDoc.answers === 'object' && !Array.isArray(rawDoc.answers)) {
      for (const [id, a] of Object.entries(rawDoc.answers)) {
        if (!isSafeKey(id) || !a || typeof a !== 'object') continue;
        const attempts = Math.max(0, Number(a.attempts) || 0);
        const correct = Math.max(0, Number(a.correct) || 0);
        const updatedAt = typeof a.updatedAt === 'number' ? a.updatedAt : clean.updatedAt;
        let last = '';
        if (typeof a.last === 'string') {
          last = a.last.slice(0, 16);
        } else if (typeof a.last === 'boolean' || typeof a.last === 'number') {
          last = a.last;
        }
        const date = typeof a.date === 'string' ? a.date : '';
        const devices = {};

        if (a.devices && typeof a.devices === 'object' && !Array.isArray(a.devices)) {
          for (const [devId, devStat] of Object.entries(a.devices)) {
            if (isSafeKey(devId) && devStat && typeof devStat === 'object') {
              devices[devId] = {
                attempts: Math.max(0, Number(devStat.attempts) || 0),
                correct: Math.max(0, Number(devStat.correct) || 0)
              };
            }
          }
        }
        // 若没有细分设备记录（如旧版本迁移或初次导入），归入 'legacy'，便于后续取 max 防重复计数
        if (Object.keys(devices).length === 0 && attempts > 0) {
          devices['legacy'] = { attempts, correct };
        }

        clean.answers[id] = {
          attempts,
          correct,
          last,
          updatedAt,
          devices
        };
        if (date) {
          clean.answers[id].date = date;
        }
      }
    }

    // 2. wrong: [id] -> { active: boolean, updatedAt: number }
    if (rawDoc.wrong) {
      if (Array.isArray(rawDoc.wrong)) {
        // 来自旧版 state.wrong 的纯字符串数组
        for (const item of rawDoc.wrong) {
          if (typeof item === 'string' && isSafeKey(item)) {
            clean.wrong[item] = { active: true, updatedAt: clean.updatedAt };
          }
        }
      } else if (typeof rawDoc.wrong === 'object') {
        for (const [id, w] of Object.entries(rawDoc.wrong)) {
          if (!isSafeKey(id) || !w) continue;
          if (typeof w === 'boolean') {
            clean.wrong[id] = { active: w, updatedAt: clean.updatedAt };
          } else if (typeof w === 'object') {
            clean.wrong[id] = {
              active: Boolean(w.active),
              updatedAt: typeof w.updatedAt === 'number' ? w.updatedAt : clean.updatedAt
            };
          }
        }
      }
    }

    // 3. favorites: [id] -> { active: boolean, updatedAt: number }
    if (rawDoc.favorites) {
      if (Array.isArray(rawDoc.favorites)) {
        for (const item of rawDoc.favorites) {
          if (typeof item === 'string' && isSafeKey(item)) {
            clean.favorites[item] = { active: true, updatedAt: clean.updatedAt };
          }
        }
      } else if (typeof rawDoc.favorites === 'object') {
        for (const [id, f] of Object.entries(rawDoc.favorites)) {
          if (!isSafeKey(id) || !f) continue;
          if (typeof f === 'boolean') {
            clean.favorites[id] = { active: f, updatedAt: clean.updatedAt };
          } else if (typeof f === 'object') {
            clean.favorites[id] = {
              active: Boolean(f.active),
              updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : clean.updatedAt
            };
          }
        }
      }
    }

    // 4. levels: [id] -> { passed, score, bestScore, updatedAt }
    if (rawDoc.levels && typeof rawDoc.levels === 'object' && !Array.isArray(rawDoc.levels)) {
      for (const [id, lvl] of Object.entries(rawDoc.levels)) {
        if (!isSafeKey(id) || !lvl || typeof lvl !== 'object') continue;
        clean.levels[id] = {
          passed: Boolean(lvl.passed),
          score: Math.max(0, Number(lvl.score) || 0),
          bestScore: Math.max(0, Number(lvl.bestScore || lvl.score) || 0),
          updatedAt: typeof lvl.updatedAt === 'number' ? lvl.updatedAt : clean.updatedAt
        };
      }
    }

    // 5. days: string[] (YYYY-MM-DD)
    if (Array.isArray(rawDoc.days)) {
      const daySet = new Set();
      for (const d of rawDoc.days) {
        const norm = normalizeDateStr(d);
        if (norm) daySet.add(norm);
      }
      clean.days = Array.from(daySet).sort();
    }

    // 6. drafts: [id] -> { text, updatedAt, conflicts?: [] }
    if (rawDoc.drafts && typeof rawDoc.drafts === 'object' && !Array.isArray(rawDoc.drafts)) {
      for (const [id, d] of Object.entries(rawDoc.drafts)) {
        if (!isSafeKey(id)) continue;
        if (typeof d === 'string') {
          clean.drafts[id] = {
            text: d,
            updatedAt: clean.updatedAt,
            conflicts: []
          };
        } else if (d && typeof d === 'object') {
          const conflicts = [];
          if (Array.isArray(d.conflicts)) {
            for (const c of d.conflicts) {
              if (c && typeof c.text === 'string') {
                conflicts.push({
                  text: c.text,
                  updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : clean.updatedAt,
                  deviceId: typeof c.deviceId === 'string' ? c.deviceId.slice(0, 64) : 'unknown'
                });
              }
            }
          }
          clean.drafts[id] = {
            text: typeof d.text === 'string' ? d.text : '',
            updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : clean.updatedAt,
            conflicts
          };
        }
      }
    }

    // 7. selfChecks: [id] -> { mastered, updatedAt, checkedAt }
    if (rawDoc.selfChecks && typeof rawDoc.selfChecks === 'object' && !Array.isArray(rawDoc.selfChecks)) {
      for (const [id, sc] of Object.entries(rawDoc.selfChecks)) {
        if (!isSafeKey(id) || !sc || typeof sc !== 'object') continue;
        clean.selfChecks[id] = {
          mastered: Boolean(sc.mastered),
          updatedAt: typeof sc.updatedAt === 'number' ? sc.updatedAt : clean.updatedAt,
          checkedAt: typeof sc.checkedAt === 'string' ? sc.checkedAt : (typeof sc.date === 'string' ? sc.date : '')
        };
      }
    }

    // 严格检查 JSON 字节大小是否超标 (<= 2MB)
    const jsonStr = JSON.stringify(clean);
    const byteLen = getBytesLength(jsonStr);
    if (byteLen > MAX_DOCUMENT_BYTES) {
      throw new Error(`Progress document size (${byteLen} bytes) exceeds maximum limit (${MAX_DOCUMENT_BYTES} bytes)`);
    }

    return clean;
  }

  /**
   * 将 app.js 的本地 state 转换为带有时间戳与设备指纹的云文档
   * @param {Object} state app.js state
   * @param {Object} baselineDoc 之前已知的基线云文档（用于推导删除项的 tombstone）
   * @param {Object} options { deviceId, now }
   */
  function stateToDocument(state, baselineDoc, options) {
    const opts = options || {};
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const deviceId = opts.deviceId || baselineDoc?.deviceId || generateDeviceId();

    const doc = createBlankDocument(deviceId);
    doc.updatedAt = now;

    // 1. answers
    const baseAnswers = baselineDoc?.answers || {};
    if (state.answers && typeof state.answers === 'object') {
      for (const [id, ans] of Object.entries(state.answers)) {
        if (!isSafeKey(id) || !ans) continue;
        const attempts = Math.max(0, Number(ans.attempts) || 0);
        const correct = Math.max(0, Number(ans.correct) || 0);
        let last = '';
        if (typeof ans.last === 'string') {
          last = ans.last;
        } else if (typeof ans.last === 'boolean' || typeof ans.last === 'number') {
          last = ans.last;
        }
        const date = typeof ans.date === 'string' ? ans.date : '';
        const baseAns = baseAnswers[id];

        let devices = {};
        let updatedAt = now;
        if (baseAns && baseAns.devices) {
          devices = deepClone(baseAns.devices);
          // 如果尝试次数相比基线发生了变动，累计到当前设备
          const baseAttempts = baseAns.attempts || 0;
          const diffAttempts = Math.max(0, attempts - baseAttempts);
          const baseCorrect = baseAns.correct || 0;
          const diffCorrect = Math.max(0, correct - baseCorrect);

          const curDev = devices[deviceId] || { attempts: 0, correct: 0 };
          curDev.attempts = (curDev.attempts || 0) + diffAttempts;
          curDev.correct = (curDev.correct || 0) + diffCorrect;
          devices[deviceId] = curDev;

          if (diffAttempts > 0 || last !== baseAns.last) {
            updatedAt = now;
          } else {
            updatedAt = baseAns.updatedAt || now;
          }
        } else {
          devices[deviceId] = { attempts, correct };
          updatedAt = now;
        }

        doc.answers[id] = { attempts, correct, last, updatedAt, devices };
        if (date) {
          doc.answers[id].date = date;
        }
      }
    }

    // 2. wrong: 对比 baseline 生成 tombstone
    const stateWrongSet = new Set(Array.isArray(state.wrong) ? state.wrong : []);
    const baseWrong = baselineDoc?.wrong || {};
    // 先记录当前存在的
    for (const id of stateWrongSet) {
      if (!isSafeKey(id)) continue;
      const baseItem = baseWrong[id];
      if (baseItem && baseItem.active) {
        doc.wrong[id] = { active: true, updatedAt: baseItem.updatedAt || now };
      } else {
        doc.wrong[id] = { active: true, updatedAt: now };
      }
    }
    // 对比 baseline 中曾 active 但现在没了的，打上 active: false 墓碑
    for (const [id, item] of Object.entries(baseWrong)) {
      if (!isSafeKey(id)) continue;
      if (item && item.active && !stateWrongSet.has(id)) {
        doc.wrong[id] = { active: false, updatedAt: now };
      }
    }

    // 3. favorites: 同样处理墓碑
    const stateFavSet = new Set(Array.isArray(state.favorites) ? state.favorites : []);
    const baseFav = baselineDoc?.favorites || {};
    for (const id of stateFavSet) {
      if (!isSafeKey(id)) continue;
      const baseItem = baseFav[id];
      if (baseItem && baseItem.active) {
        doc.favorites[id] = { active: true, updatedAt: baseItem.updatedAt || now };
      } else {
        doc.favorites[id] = { active: true, updatedAt: now };
      }
    }
    for (const [id, item] of Object.entries(baseFav)) {
      if (!isSafeKey(id)) continue;
      if (item && item.active && !stateFavSet.has(id)) {
        doc.favorites[id] = { active: false, updatedAt: now };
      }
    }

    // 4. levels
    const baseLevels = baselineDoc?.levels || {};
    if (state.levels && typeof state.levels === 'object') {
      for (const [id, lvl] of Object.entries(state.levels)) {
        if (!isSafeKey(id) || !lvl) continue;
        const baseLvl = baseLevels[id];
        const passed = Boolean(lvl.passed);
        const score = Math.max(0, Number(lvl.score) || 0);
        const bestScore = Math.max(score, Number(lvl.bestScore || (baseLvl ? baseLvl.bestScore : 0)) || 0);
        let updatedAt = now;
        if (baseLvl && baseLvl.passed === passed && baseLvl.score === score && baseLvl.bestScore === bestScore) {
          updatedAt = baseLvl.updatedAt || now;
        }
        doc.levels[id] = { passed, score, bestScore, updatedAt };
      }
    }

    // 5. days
    const daySet = new Set(Array.isArray(state.days) ? state.days : []);
    doc.days = Array.from(daySet).sort();

    // 6. drafts
    const baseDrafts = baselineDoc?.drafts || {};
    if (state.drafts && typeof state.drafts === 'object') {
      for (const [id, textVal] of Object.entries(state.drafts)) {
        if (!isSafeKey(id)) continue;
        const text = typeof textVal === 'string' ? textVal : '';
        const baseD = baseDrafts[id];
        if (baseD && baseD.text === text) {
          doc.drafts[id] = {
            text,
            updatedAt: baseD.updatedAt || now,
            conflicts: Array.isArray(baseD.conflicts) ? deepClone(baseD.conflicts) : []
          };
        } else {
          doc.drafts[id] = {
            text,
            updatedAt: now,
            conflicts: baseD && Array.isArray(baseD.conflicts) ? deepClone(baseD.conflicts) : []
          };
        }
      }
    }

    // 7. selfChecks
    const baseChecks = baselineDoc?.selfChecks || {};
    if (state.selfChecks && typeof state.selfChecks === 'object') {
      for (const [id, sc] of Object.entries(state.selfChecks)) {
        if (!isSafeKey(id) || !sc) continue;
        const mastered = Boolean(sc.mastered);
        const baseSc = baseChecks[id];
        let updatedAt = now;
        if (baseSc && baseSc.mastered === mastered) {
          updatedAt = baseSc.updatedAt || now;
        }
        doc.selfChecks[id] = {
          mastered,
          updatedAt,
          checkedAt: sc.checkedAt || sc.date || ''
        };
      }
    }
    // 检查取消自评 (曾有但在当前 state 缺失或变更)
    for (const [id, baseSc] of Object.entries(baseChecks)) {
      if (!isSafeKey(id)) continue;
      if (baseSc && baseSc.mastered && (!state.selfChecks || !state.selfChecks[id])) {
        doc.selfChecks[id] = {
          mastered: false,
          updatedAt: now,
          checkedAt: baseSc.checkedAt || ''
        };
      }
    }

    return sanitizeForCloud(doc, { deviceId });
  }

  /**
   * 将云文档转换为 app.js 所需的本地 state 格式
   * 保留既有 state 中属于本地的 session、teaching 等私有数据
   */
  function documentToState(doc, existingState) {
    const s = existingState ? deepClone(existingState) : {
      version: 1,
      answers: {},
      wrong: [],
      favorites: [],
      levels: {},
      days: [],
      session: null,
      drafts: {},
      selfChecks: {},
      teaching: {}
    };

    if (!doc || typeof doc !== 'object') return s;

    // 1. answers
    s.answers = {};
    if (doc.answers) {
      for (const [id, a] of Object.entries(doc.answers)) {
        if (!isSafeKey(id) || !a) continue;
        let last = '';
        if (typeof a.last === 'string') {
          last = a.last;
        } else if (typeof a.last === 'boolean' || typeof a.last === 'number') {
          last = a.last;
        }
        s.answers[id] = {
          attempts: Math.max(0, Number(a.attempts) || 0),
          correct: Math.max(0, Number(a.correct) || 0),
          last
        };
        if (typeof a.date === 'string') {
          s.answers[id].date = a.date;
        }
      }
    }

    // 2. wrong: 过滤 active 为 true 的项
    const wrongList = [];
    if (doc.wrong) {
      for (const [id, w] of Object.entries(doc.wrong)) {
        if (!isSafeKey(id)) continue;
        if (w && w.active) wrongList.push(id);
      }
    }
    s.wrong = wrongList;

    // 3. favorites: 过滤 active 为 true 的项
    const favList = [];
    if (doc.favorites) {
      for (const [id, f] of Object.entries(doc.favorites)) {
        if (!isSafeKey(id)) continue;
        if (f && f.active) favList.push(id);
      }
    }
    s.favorites = favList;

    // 4. levels
    s.levels = {};
    if (doc.levels) {
      for (const [id, lvl] of Object.entries(doc.levels)) {
        if (!isSafeKey(id) || !lvl) continue;
        s.levels[id] = {
          passed: Boolean(lvl.passed),
          score: Math.max(0, Number(lvl.score) || 0),
          bestScore: Math.max(0, Number(lvl.bestScore || lvl.score) || 0)
        };
      }
    }

    // 5. days
    s.days = Array.isArray(doc.days) ? [...doc.days] : [];

    // 6. drafts: text 写入主字段，冲突记录存放在 s.draftConflicts
    s.drafts = {};
    s.draftConflicts = {};
    if (doc.drafts) {
      for (const [id, d] of Object.entries(doc.drafts)) {
        if (!isSafeKey(id) || !d) continue;
        s.drafts[id] = typeof d.text === 'string' ? d.text : '';
        if (Array.isArray(d.conflicts) && d.conflicts.length > 0) {
          s.draftConflicts[id] = deepClone(d.conflicts);
        }
      }
    }

    // 7. selfChecks: 仅保留 mastered === true
    s.selfChecks = {};
    if (doc.selfChecks) {
      for (const [id, sc] of Object.entries(doc.selfChecks)) {
        if (!isSafeKey(id) || !sc) continue;
        if (sc.mastered) {
          s.selfChecks[id] = {
            mastered: true,
            checkedAt: sc.checkedAt || '',
            date: sc.checkedAt || ''
          };
        }
      }
    }

    return s;
  }

  /**
   * 核心三路/双路合并：合并 localDoc 与 remoteDoc
   * 满足契约：
   * 1. 幂等：merge(A, A) === A
   * 2. 并发不同题目：同时保留
   * 3. 同一答题快照不双计数：相同设备记录取 max，不同设备记录按设备累加
   * 4. 收藏/错题删除不复活：以最新时间戳的 tombstone (active: false) 为准
   * 5. 自评取消不复活：mastered: false 带有更新时间戳时覆盖旧 mastered: true
   * 6. 草稿并发冲突：保留胜出者，并将另一方纳入 conflicts，绝不静默丢弃
   * 7. 关卡最高成绩合并：passed 取并集，成绩取 max
   */
  function mergeProgress(localDoc, remoteDoc, options) {
    const opts = options || {};
    const now = typeof opts.now === 'number' ? opts.now : Date.now();

    const cleanLocal = sanitizeForCloud(localDoc || createBlankDocument('local'));
    const cleanRemote = sanitizeForCloud(remoteDoc || createBlankDocument('remote'));

    const merged = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Math.max(cleanLocal.updatedAt || 0, cleanRemote.updatedAt || 0, now),
      deviceId: cleanLocal.deviceId || cleanRemote.deviceId || generateDeviceId(),
      answers: {},
      wrong: {},
      favorites: {},
      levels: {},
      days: [],
      drafts: {},
      selfChecks: {}
    };

    // 1. 合并 answers
    const allAnswerKeys = new Set([...Object.keys(cleanLocal.answers), ...Object.keys(cleanRemote.answers)]);
    for (const id of allAnswerKeys) {
      if (!isSafeKey(id)) continue;
      const la = cleanLocal.answers[id];
      const ra = cleanRemote.answers[id];

      if (!la) {
        merged.answers[id] = deepClone(ra);
        continue;
      }
      if (!ra) {
        merged.answers[id] = deepClone(la);
        continue;
      }

      // 两边均有此题作答记录
      // 合并细分设备
      const devMap = {};
      const allDevs = new Set([...Object.keys(la.devices || {}), ...Object.keys(ra.devices || {})]);

      if (allDevs.size > 0) {
        for (const dev of allDevs) {
          if (!isSafeKey(dev)) continue;
          const ld = (la.devices && la.devices[dev]) || { attempts: 0, correct: 0 };
          const rd = (ra.devices && ra.devices[dev]) || { attempts: 0, correct: 0 };
          devMap[dev] = {
            attempts: Math.max(ld.attempts || 0, rd.attempts || 0),
            correct: Math.max(ld.correct || 0, rd.correct || 0)
          };
        }
      }

      // 计算总数：如果有设备明细，按设备加和；否则（旧版迁移）取最大值
      let totalAttempts = 0;
      let totalCorrect = 0;
      if (Object.keys(devMap).length > 0) {
        for (const devStat of Object.values(devMap)) {
          totalAttempts += devStat.attempts;
          totalCorrect += devStat.correct;
        }
      } else {
        totalAttempts = Math.max(la.attempts || 0, ra.attempts || 0);
        totalCorrect = Math.max(la.correct || 0, ra.correct || 0);
      }

      // 保证正确数不超过总尝试数
      totalCorrect = Math.min(totalCorrect, totalAttempts);

      // 最后作答选项：取时间戳更新的一方
      const last = (ra.updatedAt > la.updatedAt) ? (ra.last ?? la.last) : (la.last ?? ra.last);
      const date = (ra.updatedAt > la.updatedAt) ? (ra.date || la.date) : (la.date || ra.date);
      const updatedAt = Math.max(la.updatedAt || 0, ra.updatedAt || 0);

      merged.answers[id] = {
        attempts: totalAttempts,
        correct: totalCorrect,
        last,
        updatedAt,
        devices: devMap
      };
      if (date) {
        merged.answers[id].date = date;
      }
    }

    // 2. 合并 wrong (LWW-Element-Set)
    const allWrongKeys = new Set([...Object.keys(cleanLocal.wrong), ...Object.keys(cleanRemote.wrong)]);
    for (const id of allWrongKeys) {
      if (!isSafeKey(id)) continue;
      const lw = cleanLocal.wrong[id];
      const rw = cleanRemote.wrong[id];

      if (!lw) {
        merged.wrong[id] = deepClone(rw);
        continue;
      }
      if (!rw) {
        merged.wrong[id] = deepClone(lw);
        continue;
      }

      // 两方均存在，比较 updatedAt
      if (rw.updatedAt > lw.updatedAt) {
        merged.wrong[id] = deepClone(rw);
      } else if (lw.updatedAt > rw.updatedAt) {
        merged.wrong[id] = deepClone(lw);
      } else {
        // 时间戳完全相同时，active 为 true 优先
        merged.wrong[id] = {
          active: lw.active || rw.active,
          updatedAt: lw.updatedAt
        };
      }
    }

    // 3. 合并 favorites (LWW-Element-Set)
    const allFavKeys = new Set([...Object.keys(cleanLocal.favorites), ...Object.keys(cleanRemote.favorites)]);
    for (const id of allFavKeys) {
      if (!isSafeKey(id)) continue;
      const lf = cleanLocal.favorites[id];
      const rf = cleanRemote.favorites[id];

      if (!lf) {
        merged.favorites[id] = deepClone(rf);
        continue;
      }
      if (!rf) {
        merged.favorites[id] = deepClone(lf);
        continue;
      }

      if (rf.updatedAt > lf.updatedAt) {
        merged.favorites[id] = deepClone(rf);
      } else if (lf.updatedAt > rf.updatedAt) {
        merged.favorites[id] = deepClone(lf);
      } else {
        merged.favorites[id] = {
          active: lf.active || rf.active,
          updatedAt: lf.updatedAt
        };
      }
    }

    // 4. 合并 levels
    const allLevelKeys = new Set([...Object.keys(cleanLocal.levels), ...Object.keys(cleanRemote.levels)]);
    for (const id of allLevelKeys) {
      if (!isSafeKey(id)) continue;
      const ll = cleanLocal.levels[id];
      const rl = cleanRemote.levels[id];

      if (!ll) {
        merged.levels[id] = deepClone(rl);
        continue;
      }
      if (!rl) {
        merged.levels[id] = deepClone(ll);
        continue;
      }

      merged.levels[id] = {
        passed: Boolean(ll.passed || rl.passed),
        score: Math.max(ll.score || 0, rl.score || 0),
        bestScore: Math.max(ll.bestScore || ll.score || 0, rl.bestScore || rl.score || 0),
        updatedAt: Math.max(ll.updatedAt || 0, rl.updatedAt || 0)
      };
    }

    // 5. 合并 days (Set 并集排序)
    const daySet = new Set([...(cleanLocal.days || []), ...(cleanRemote.days || [])]);
    merged.days = Array.from(daySet).sort();

    // 6. 合并 drafts (并发冲突检测与保留)
    const allDraftKeys = new Set([...Object.keys(cleanLocal.drafts), ...Object.keys(cleanRemote.drafts)]);
    for (const id of allDraftKeys) {
      if (!isSafeKey(id)) continue;
      const ld = cleanLocal.drafts[id];
      const rd = cleanRemote.drafts[id];

      if (!ld) {
        merged.drafts[id] = deepClone(rd);
        continue;
      }
      if (!rd) {
        merged.drafts[id] = deepClone(ld);
        continue;
      }

      // 如果文本完全一致，合并 conflicts 即可
      if (ld.text === rd.text) {
        const combinedConflicts = [...(ld.conflicts || []), ...(rd.conflicts || [])];
        merged.drafts[id] = {
          text: ld.text,
          updatedAt: Math.max(ld.updatedAt || 0, rd.updatedAt || 0),
          conflicts: dedupeConflicts(combinedConflicts, ld.text)
        };
        continue;
      }

      // 文本不一致，产生冲突！
      // 较新时间戳作为 primary text，较旧的一方存入 conflicts 列表中，绝不静默丢失
      let primary;
      let secondary;
      if ((rd.updatedAt || 0) > (ld.updatedAt || 0)) {
        primary = rd;
        secondary = ld;
      } else {
        primary = ld;
        secondary = rd;
      }

      const allConflicts = [
        ...(primary.conflicts || []),
        ...(secondary.conflicts || []),
        {
          text: secondary.text,
          updatedAt: secondary.updatedAt || now,
          deviceId: secondary.deviceId || 'other'
        }
      ];

      merged.drafts[id] = {
        text: primary.text,
        updatedAt: Math.max(primary.updatedAt || 0, secondary.updatedAt || 0),
        conflicts: dedupeConflicts(allConflicts, primary.text)
      };
    }

    // 7. 合并 selfChecks (LWW)
    const allCheckKeys = new Set([...Object.keys(cleanLocal.selfChecks), ...Object.keys(cleanRemote.selfChecks)]);
    for (const id of allCheckKeys) {
      if (!isSafeKey(id)) continue;
      const lsc = cleanLocal.selfChecks[id];
      const rsc = cleanRemote.selfChecks[id];

      if (!lsc) {
        merged.selfChecks[id] = deepClone(rsc);
        continue;
      }
      if (!rsc) {
        merged.selfChecks[id] = deepClone(lsc);
        continue;
      }

      if ((rsc.updatedAt || 0) > (lsc.updatedAt || 0)) {
        merged.selfChecks[id] = deepClone(rsc);
      } else if ((lsc.updatedAt || 0) > (rsc.updatedAt || 0)) {
        merged.selfChecks[id] = deepClone(lsc);
      } else {
        merged.selfChecks[id] = {
          mastered: lsc.mastered || rsc.mastered,
          updatedAt: lsc.updatedAt || now,
          checkedAt: lsc.checkedAt || rsc.checkedAt || ''
        };
      }
    }

    return sanitizeForCloud(merged, { deviceId: merged.deviceId });
  }

  function dedupeConflicts(conflicts, primaryText) {
    const seen = new Set([primaryText]);
    const res = [];
    for (const c of conflicts) {
      if (!c || typeof c.text !== 'string') continue;
      if (!seen.has(c.text)) {
        seen.add(c.text);
        res.push({
          text: c.text,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
          deviceId: typeof c.deviceId === 'string' ? c.deviceId : 'unknown'
        });
      }
    }
    return res;
  }

  return {
    MAX_DOCUMENT_BYTES,
    SCHEMA_VERSION,
    sanitizeForCloud,
    stateToDocument,
    documentToState,
    mergeProgress,
    createBlankDocument,
    generateDeviceId
  };
});
