window.__ModuleLoader__.load({
  id: 'dsh-laodi',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const NS = 'dsh-laodi';
    const ROUTE = '/dsh-laodi-9101';
    const CSS = [
      '.' + NS + '-cfg{max-width:720px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-text-primary,#1c1c1e);font-size:13px;}',
      '.' + NS + '-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-text-secondary,#6b6b70);background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));padding:9px 11px;border-radius:9px;}',
      '.' + NS + '-card{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-radius:11px;padding:12px 14px;display:flex;flex-direction:column;gap:11px;}',
      '.' + NS + '-card__title{font-size:13px;font-weight:600;margin:0;}',
      '.' + NS + '-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}',
      '.' + NS + '-row__label{width:132px;flex:0 0 auto;padding-top:5px;color:var(--dsw-alias-text-secondary,#6b6b70);}',
      '.' + NS + '-row__body{flex:1 1 260px;min-width:220px;display:flex;flex-direction:column;gap:5px;}',
      '.' + NS + '-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-text-secondary,#8a8a90);}',
      '.' + NS + '-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;}',
      '.' + NS + '-switch input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#247bbf);}',
      '.' + NS + '-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.' + NS + '-btn{padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.35));background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.1));color:var(--dsw-alias-text-primary,#1c1c1e);}',
      '.' + NS + '-btn:hover{border-color:var(--dsw-alias-brand-primary,#247bbf);}',
      '.' + NS + '-btn[disabled]{opacity:.5;cursor:default;}',
      '.' + NS + '-btn--primary{background:var(--dsw-alias-brand-primary,#247bbf);border-color:transparent;color:#fff;}',
      '.' + NS + '-out{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));padding:9px 11px;border-radius:9px;max-height:220px;overflow:auto;}',
      '.' + NS + '-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.12));color:var(--dsw-alias-text-secondary,#6b6b70);}',
      '.' + NS + '-pill--ok{background:rgba(46,160,67,.16);color:#2ea043;}',
      '.' + NS + '-pill--bad{background:rgba(207,68,68,.16);color:#cf4444;}',
      '.' + NS + '-cfg input[type="text"],.' + NS + '-cfg input[type="number"],.' + NS + '-cfg input[type="password"],.' + NS + '-cfg select{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:13px;background:var(--dsw-alias-bg-primary,rgba(255,255,255,.06));color:var(--dsw-alias-text-primary,#1c1c1e);border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.35));outline:none;font-family:inherit;}',
      '.' + NS + '-cfg input:focus,.' + NS + '-cfg select:focus{border-color:var(--dsw-alias-brand-primary,#247bbf);}',
      '.' + NS + '-opts{display:flex;flex-direction:column;gap:4px;}',
      '.' + NS + '-opt{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.5;}',
      '.' + NS + '-opt__id{color:var(--dsw-alias-text-secondary,#8a8a90);font-size:11.5px;}',
    ].join('\n');
    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css="' + NS + '"]');
      if (existing) return function () {};
      const style = document.createElement('style');
      style.dataset.pluginCss = NS;
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () { style.remove(); };
    }

    /** 和服务端 src/vision/magpie.mjs 的 pickVisionModel 保持一致的挑法 */
    function preferredModel(models) {
      const list = Array.isArray(models) ? models : [];
      const imageModels = list.filter(function (m) { return m && m.supportsImage; });
      const hit = imageModels.find(function (m) {
        return /minimax|flash/i.test(m.id || '') && !/v4-pro/i.test(m.id || '');
      });
      if (hit) return hit.id;
      if (imageModels[0]) return imageModels[0].id;
      if (list[0]) return list[0].id;
      return '';
    }

    /** 密钥来源的人话说明 */
    function describeKey(config, runtime, providers) {
      if (config && config.hasVisionApiKey) {
        return '用设置页里手填的 Key（会盖住 provider 的环境变量密钥）。';
      }
      const providerId = (config && config.visionProviderId) || (runtime && runtime.visionProviderId) || '';
      const provider = (providers || []).find(function (p) { return p.id === providerId; });
      if (!provider) {
        return '当前没锁定 provider：服务端按 DSH 默认 provider（' +
          ((runtime && runtime.visionProviderId) || '未找到') + '）取密钥。';
      }
      const env = provider.apiKeyEnv || '(未设置 apiKeyEnv)';
      if (provider.hasApiKey) {
        return '密钥来自 ' + env + '（' + (provider.keySourceLabel || provider.keySource || '未知来源') +
          '），明文不经过设置页。';
      }
      if (provider.localGateway) {
        return '本机网关（' + (provider.baseURL || '') + '）不校验密钥：' + env +
          ' 没找到也能跑，缺 Key 时用占位串。';
      }
      return '没找到 ' + env + '（' + (provider.keySourceLabel || provider.keySource || '未找到') +
        '）：远端接口拿不到 Key，视觉会退回 mock。';
    }

    function SettingsSection() {
      const cfgState = useState(null);
      const config = cfgState[0];
      const setConfig = cfgState[1];
      const metaState = useState(null);
      const meta = metaState[0];
      const setMeta = metaState[1];
      const errState = useState(null);
      const error = errState[0];
      const setError = errState[1];
      const busyState = useState(null);
      const busy = busyState[0];
      const setBusy = busyState[1];
      const outState = useState('');
      const output = outState[0];
      const setOutput = outState[1];
      const saveStateHook = useState(null);
      const saveState = saveStateHook[0];
      const setSaveState = saveStateHook[1];
      const keyState = useState('');
      const keyDraft = keyState[0];
      const setKeyDraft = keyState[1];
      const saveTimer = useRef(null);

      const load = async function () {
        try {
          const response = await fetch(ROUTE + '/config', { cache: 'no-store' });
          const payload = await response.json();
          if (!payload || !payload.ok) throw new Error((payload && payload.message) || 'read config failed');
          setConfig(payload.config);
          setMeta(payload);
          setError(null);
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
        }
      };

      useEffect(function () {
        void load();
        return function () {
          if (saveTimer.current) window.clearTimeout(saveTimer.current);
        };
      }, []);

      const patch = function (changes, opts) {
        const immediate = !!(opts && opts.immediate);
        setConfig(function (previous) { return Object.assign({}, previous || {}, changes); });
        const send = async function () {
          setBusy('save');
          setSaveState({ kind: 'saving', text: 'saving...' });
          try {
            const body = Object.assign({}, changes);
            if (Object.prototype.hasOwnProperty.call(body, 'visionApiKey') && body.visionApiKey === '') {
              body.visionApiKey = '__KEEP__';
            }
            const response = await fetch(ROUTE + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            const payload = await response.json();
            if (!payload || !payload.ok) throw new Error((payload && payload.message) || 'save failed');
            setConfig(payload.config);
            setSaveState({ kind: 'ok', text: 'saved ' + new Date().toLocaleTimeString() });
            setError(null);
            void load();
          } catch (cause) {
            const text = String((cause && cause.message) || cause);
            setError(text);
            setSaveState({ kind: 'bad', text: 'save failed: ' + text });
          } finally {
            setBusy(null);
          }
        };
        if (immediate) {
          if (saveTimer.current) window.clearTimeout(saveTimer.current);
          void send();
        } else {
          if (saveTimer.current) window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(function () { void send(); }, 450);
        }
      };

      const field = function (label, body, hint) {
        return h('div', { className: NS + '-row' },
          h('div', { className: NS + '-row__label' }, label),
          h('div', { className: NS + '-row__body' }, body, hint ? h('div', { className: NS + '-hint' }, hint) : null),
        );
      };

      const toggle = function (key, label) {
        return h('label', { className: NS + '-switch' },
          h('input', {
            type: 'checkbox',
            checked: Boolean(config && config[key]),
            onChange: function (event) {
              const o = {};
              o[key] = event.currentTarget.checked;
              patch(o, { immediate: true });
            },
          }),
          h('span', null, label),
        );
      };

      const number = function (key, min, max, step) {
        return h('input', {
          type: 'number',
          min: min,
          max: max,
          step: step == null ? 1 : step,
          value: config && config[key] != null ? config[key] : '',
          onChange: function (event) {
            const value = Number(event.currentTarget.value);
            if (Number.isFinite(value)) {
              const o = {};
              o[key] = value;
              patch(o);
            }
          },
        });
      };

      const text = function (key, placeholder) {
        return h('input', {
          type: 'text',
          value: (config && config[key]) || '',
          placeholder: placeholder,
          onChange: function (event) {
            const o = {};
            o[key] = event.currentTarget.value;
            patch(o);
          },
        });
      };

      const runOnce = async function () {
        setBusy('once');
        setOutput('running...');
        try {
          const response = await fetch(ROUTE + '/once', { method: 'POST' });
          setOutput(JSON.stringify(await response.json(), null, 2));
        } catch (cause) {
          setOutput('request failed: ' + String((cause && cause.message) || cause));
        } finally {
          setBusy(null);
        }
      };

      const testVision = async function () {
        setBusy('vision');
        setOutput('testing vision...');
        try {
          const response = await fetch(ROUTE + '/vision/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              visionProviderId: (config && config.visionProviderId) || '',
              visionBaseURL: (config && config.visionBaseURL) || '',
              visionModel: (config && config.visionModel) || '',
              visionApiKeyEnv: (config && config.visionApiKeyEnv) || '',
              visionApiKey: keyDraft === '' ? '__KEEP__' : keyDraft,
            }),
          });
          const payload = await response.json();
          setOutput(payload.ok ? ('OK\n' + JSON.stringify(payload.result, null, 2)) : ('FAIL\n' + (payload.message || '')));
        } catch (cause) {
          setOutput('request failed: ' + String((cause && cause.message) || cause));
        } finally {
          setBusy(null);
        }
      };

      if (error && !config) {
        return h('div', { className: NS + '-cfg' }, h('div', { className: NS + '-out' }, 'config unavailable: ' + error));
      }
      if (!config) {
        return h('div', { className: NS + '-cfg' }, h('div', { className: NS + '-hint' }, 'loading...'));
      }

      const magpie = (meta && meta.magpie) || {};
      const runtime = (meta && meta.runtime) || {};
      const dshProviders = (meta && meta.dshProviders) || [];
      const dshModels = (meta && meta.dshModels) || [];
      const dsh = (meta && meta.dsh) || {};

      // 当前锁定的 provider（没锁就用运行中的那个）
      const providerId = config.visionProviderId || runtime.visionProviderId || '';
      const activeProvider = dshProviders.find(function (p) { return p.id === providerId; }) || null;
      const visibleModels = providerId
        ? dshModels.filter(function (m) { return m.providerId === providerId; })
        : dshModels.slice();

      // 手动填的模型 id 可能不在 DSH 列表里（下拉里补一项，免得显示空白）
      const modelValues = visibleModels.map(function (m) { return m.id; });
      if (config.visionModel && modelValues.indexOf(config.visionModel) < 0) {
        modelValues.push(config.visionModel);
      }

      const onProviderChange = function (event) {
        const value = event.currentTarget.value;
        if (!value) {
          // 自动：让服务端按 DSH 默认 provider / 默认模型来挑
          patch({ visionProviderId: '', visionBaseURL: '', visionModel: '' }, { immediate: true });
          return;
        }
        const provider = dshProviders.find(function (p) { return p.id === value; }) || null;
        const models = dshModels.filter(function (m) { return m.providerId === value; });
        const nextModel = preferredModel(models);
        const changes = { visionProviderId: value };
        if (provider) changes.visionBaseURL = provider.baseURL || '';
        if (nextModel) changes.visionModel = nextModel;
        patch(changes, { immediate: true });
      };

      const onModelChange = function (event) {
        const value = event.currentTarget.value;
        if (!value) {
          patch({ visionModel: '' }, { immediate: true });
          return;
        }
        const item = dshModels.find(function (m) { return m.id === value; }) || null;
        const changes = { visionModel: value };
        if (item) {
          changes.visionProviderId = item.providerId;
          if (item.baseURL) changes.visionBaseURL = item.baseURL;
        }
        patch(changes, { immediate: true });
      };

      return h('div', { className: NS + '-cfg' },
        h('div', { className: NS + '-note' }, '小时候家里看着你玩电脑的弟弟：陪玩、找攻略、帮你记事。改完自动保存到本地 dsh-laodi.json；视觉默认走 DSH 已配置的 provider（Magpie 网关）。'),
        saveState ? h('div', {
          className: NS + '-out',
          style: saveState.kind === 'ok' ? { color: '#2ea043' } : (saveState.kind === 'bad' ? { color: '#cf4444' } : undefined),
        }, saveState.text) : null,
        h('div', { className: NS + '-card' },
          h('h3', { className: NS + '-card__title' }, '开关与节奏'),
          field('启用', toggle('enabled', '开启陪玩主循环')),
          field('识屏间隔', number('captureIntervalSec', 60, 300), '秒。SPEC 建议 90–120。'),
          field('开口间隔', number('minSpeakGapSec', 180, 86400), '秒。主动开口最少间隔，≥180。'),
          field('开口概率', number('speakProbability', 0, 0.3, 0.05), '0–0.3。'),
          field('气泡字数', number('bubbleMaxChars', 5, 40), '≤40。'),
          field('标定日期', text('calibrateDate', '例如 04/17'), '游戏内月/日；填了会刷新今日提醒。'),
        ),
        h('div', { className: NS + '-card' },
          h('h3', { className: NS + '-card__title' }, '视觉模型（从 DSH 已配置的 provider 里挑）'),
          h('div', { className: NS + '-hint' },
            '当前运行：',
            h('span', { className: NS + '-pill ' + (runtime.mock ? NS + '-pill--bad' : NS + '-pill--ok') }, runtime.mock ? 'mock' : 'live'),
            ' ',
            runtime.visionModel || '(未就绪)',
            magpie.providerName ? (' · ' + magpie.providerName) : '',
            magpie.source ? (' · 探测来源 ' + magpie.source) : '',
          ),
          field('Provider',
            h('select', { value: providerId, onChange: onProviderChange },
              [h('option', { key: '__auto', value: '' }, '自动（DSH 默认 provider）')].concat(
                dshProviders.map(function (p) {
                  return h('option', { key: p.id, value: p.id }, p.name + ' · ' + p.id);
                }),
              ),
            ),
            dshProviders.length
              ? ('读到 ' + dshProviders.length + ' 个 provider（来源 ' + (dsh.source || '未知') + '）。选了哪个，baseURL 和密钥来源就跟着它走。')
              : '没在 DSH 里读到 provider：检查 ' + (dsh.settingsFile || '~/.dsh/settings.yaml') + '。',
          ),
          field('视觉模型',
            h('select', { value: config.visionModel || '', onChange: onModelChange },
              [h('option', { key: '__auto', value: '' }, '自动选（可识图的模型）')].concat(
                modelValues.map(function (id) {
                  const item = visibleModels.find(function (m) { return m.id === id; });
                  return h('option', { key: id, value: id }, item ? (item.name + ' · ' + id) : id);
                }),
              ),
            ),
            providerId
              ? ('只列 ' + providerId + ' 的模型。留空 = 服务端按 DSH 默认模型自动挑。')
              : '还没锁 provider：这里列的是全部 provider 的模型。',
          ),
          h('div', { className: NS + '-opts' },
            visibleModels.slice(0, 12).map(function (m) {
              return h('div', { key: m.providerId + '::' + m.id, className: NS + '-opt' },
                h('span', { className: NS + '-pill' + (m.supportsImage ? ' ' + NS + '-pill--ok' : '') },
                  m.supportsImage ? '识图' : '纯文本'),
                h('span', null, m.name || m.id),
                h('span', { className: NS + '-opt__id' }, m.id + ' · ' + (m.providerName || m.providerId)),
              );
            }),
          ),
          field('密钥来源',
            h('div', { className: NS + '-hint' }, describeKey(config, runtime, dshProviders)),
            'DSH provider 的密钥留在它自己的环境变量里（' +
            ((activeProvider && activeProvider.apiKeyEnv) || 'apiKeyEnv') +
            '），设置页只看得到「找没找到」，明文不回显、不进日志。',
          ),
        ),
        h('div', { className: NS + '-card' },
          h('h3', { className: NS + '-card__title' }, '手动覆盖（一般不用动）'),
          field('强制 mock', toggle('visionMock', '不调真实模型（调试用）')),
          field('接口地址', text('visionBaseURL', magpie.baseURL || 'http://127.0.0.1:3425/v1'), '留空 = 用 DSH provider 的 baseURL。'),
          field('模型 ID', text('visionModel', magpie.model || 'deepseek/deepseek-flash'), '留空 = 自动选。'),
          field('密钥环境变量', text('visionApiKeyEnv', (activeProvider && activeProvider.apiKeyEnv) || 'MAGPIE_GATEWAY_KEY'), '留空 = 用 provider 自己的 apiKeyEnv。'),
          field('API Key',
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                type: 'password',
                autoComplete: 'off',
                value: keyDraft,
                placeholder: config.hasVisionApiKey ? '已保存（留空=不改）' : '留空=用 provider 的密钥',
                onChange: function (event) {
                  const value = event.currentTarget.value;
                  setKeyDraft(value);
                  patch({ visionApiKey: value === '' ? '__KEEP__' : value });
                },
              }),
              h('button', {
                className: NS + '-btn',
                onClick: function () { setKeyDraft(''); patch({ visionApiKey: '__CLEAR__' }, { immediate: true }); },
              }, '清除'),
            ),
            '手填的 Key 会盖住 provider 的环境变量密钥；只存在本机 dsh-laodi.json，界面不回显。',
          ),
        ),
        h('div', { className: NS + '-actions' },
          h('button', { className: NS + '-btn ' + NS + '-btn--primary', onClick: runOnce, disabled: busy === 'once' }, busy === 'once' ? '正在跑…' : '立刻试一轮'),
          h('button', { className: NS + '-btn', onClick: testVision, disabled: busy === 'vision' }, busy === 'vision' ? '测试中…' : '测一下视觉'),
          h('button', { className: NS + '-btn', onClick: function () { void load(); } }, '刷新'),
        ),
        output ? h('div', { className: NS + '-out' }, output) : null,
        error ? h('div', { className: NS + '-out' }, '出错了：' + error) : null,
      );
    }

    return {
      name: 'dsh-laodi',
      inject: ['slots'],
      apply: function (ctx) {
        ctx.effect(installStyles, 'dsh-laodi: styles');
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'dsh-laodi-config', order: 32, label: function () { return '老弟 · P5R'; } },
            SettingsSection,
          );
        });
      },
    };
  },
});
