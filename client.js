/**
 * context-meter — Client half of the Context Meter bundle.
 *
 * One compact, always-visible line beside the composer says how much of the
 * auto-compaction budget is still free:
 *
 *   宽裕 42% · 余 24万
 *
 * The first word changes with the pressure band, the color changes at 60% and
 * 85%, and the hover carries one plain sentence (no numbers — they are already
 * in the line).
 *
 * ## Where the numbers come from (no estimation)
 *
 * - Used tokens: the Session's own `contextPressure` projection
 *   (`@deepseek-ai/dsh-token-meter`), which folds `inputTokens +
 *   cacheReadTokens + cacheWriteTokens` of the newest usage sample. This is the
 *   exact same value DSH's built-in ring meter in the composer skeleton reads.
 * - Context window: `contextPressure.contextWindow`, written from the newest
 *   `request/context` session event.
 * - Output reserve: `maxTokens` of the newest `request/header` event in the
 *   Session's event window (`data.header.config.maxTokens`). That is the same
 *   field `compaction-basic` uses as `reservedCompletionTokens`.
 *
 * The threshold mirrors `@deepseek-ai/dsh-compaction-basic`:
 *
 *   floor(min(W * 0.8, W - maxTokens - 65536))      (0.8 / 65536 are its
 *                                                   thresholdRatio / headroom)
 *
 * When maxTokens is unreadable the threshold falls back to `floor(W * 0.8)`,
 * exactly the same package's behavior with no declared completion cap.
 *
 * Nothing is ever estimated: a reading with no usable pressure or window is not
 * rendered at all (`null`), and a malformed shape warns once.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-meter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'context-meter';
    /** Style tag identity used for the one injectable stylesheet. */
    const STYLE_ID = 'dsh-context-meter/styles';
    /** Session-scope list slot in the composer's leading control row. */
    const SLOT = 'conversation.input.left';
    /** `compaction-basic` defaults: thresholdRatio and headroomTokens. */
    const THRESHOLD_RATIO = 0.8;
    const HEADROOM_TOKENS = 65536;
    /** How often an unbound session is retried before the reading gives up. */
    const ATTACH_RETRY_MS = 500;
    const ATTACH_RETRY_LIMIT = 40;

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'meter.line': '{head} · {toCompact} · {toLimit}',
      'meter.toCompact': '距压缩 {value}',
      'meter.toLimit': '距上限 {value}',
      'tier.roomy': '宽裕',
      'tier.half': '过半',
      'tier.tight': '吃紧',
      'tier.leave': '该走了',
      'tier.last': '最后一程',
      'hint.roomy': '还早着呢，随便聊。',
      'hint.half': '一半没了，剩下的够用一阵。',
      'hint.tight': '有点挤了，说重点吧。',
      'hint.leave': '该到分别的时候了——开个新会话，我还认得你。',
      'hint.last': '再不走，前面说过的话我就要忘了。',
      'unit.value': '{value}万',
      'unit.under': '不足1万',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'meter.line': '{head} · {toCompact} · {toLimit}',
      'meter.toCompact': '{value} to compact',
      'meter.toLimit': '{value} to limit',
      'tier.roomy': 'Roomy',
      'tier.half': 'Half gone',
      'tier.tight': 'Tight',
      'tier.leave': 'Time to go',
      'tier.last': 'Last stretch',
      'hint.roomy': 'Plenty of room — chat away.',
      'hint.half': 'Half of it is gone; what is left still goes a long way.',
      'hint.tight': 'It is getting tight — stick to the point.',
      'hint.leave': 'Time to part — start a new session, I will still know you.',
      'hint.last': 'Leave now, or I will start forgetting what we said.',
      'unit.value': '{value}k',
      'unit.under': '<1k',
    };

    /**
     * Pressure bands and their first word. `at` is the lower bound as a share of
     * the compaction threshold, so the table reads as 50% / 70% / 85% / 95%.
     */
    const BANDS = [
      { id: 'roomy', at: 0 },
      { id: 'half', at: 0.5 },
      { id: 'tight', at: 0.7 },
      { id: 'leave', at: 0.85 },
      { id: 'last', at: 0.95 },
    ];

    /**
     * Only `--dsw-*` theme tokens are used, so light/dark and user skins color
     * the reading without a second source. It is plain text, not a control:
     * no focus, no click, no layout shift.
     */
    const CSS = [
      '.dsh-context-meter{box-sizing:border-box;display:inline-flex;align-items:center;height:24px;max-width:100%;margin:0;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;user-select:none}',
      '.dsh-context-meter:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-context-meter[data-level="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-context-meter[data-level="danger"]{color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    /** Warn at most once per page load; a missing reading is not an error. */
    let warned = false;
    function warnOnce(message) {
      if (warned) return;
      warned = true;
      console.warn('[context-meter] ' + message);
    }

    /** Accept only a non-negative finite token count. */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
    }

    /**
     * The compaction threshold this reading is measured against.
     * @param contextWindow - provider context window (W).
     * @param reserve - the request's `maxTokens`, or undefined when undeclared.
     * @returns threshold tokens, always positive for a positive window.
     */
    function compactionThreshold(contextWindow, reserve) {
      const byRatio = Math.floor(contextWindow * THRESHOLD_RATIO);
      if (reserve === undefined) return byRatio;
      const byBudget = Math.floor(contextWindow - reserve - HEADROOM_TOKENS);
      if (!Number.isFinite(byBudget) || byBudget <= 0) return byRatio;
      return Math.min(byRatio, byBudget);
    }

    /** The band whose lower bound the ratio has reached. */
    function bandOf(ratio) {
      let band = BANDS[0];
      for (const candidate of BANDS) if (ratio >= candidate.at) band = candidate;
      return band;
    }

    /** Color step: secondary below 60%, warning through 85%, danger above. */
    function levelOf(ratio) {
      if (ratio < 0.6) return 'muted';
      if (ratio <= 0.85) return 'warn';
      return 'danger';
    }

    /**
     * Read the newest `request/header` maxTokens from the Session's event window.
     * @param session - client Session record.
     * @returns the frozen output reserve, or undefined when no event carries one.
     */
    function readOutputReserve(session) {
      const sources = [session && session.eventSource, session && session.events];
      for (const source of sources) {
        if (source === undefined || source === null || typeof source.getSnapshot !== 'function') continue;
        let snapshot;
        try {
          snapshot = source.getSnapshot();
        } catch (error) {
          continue;
        }
        const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : undefined;
        if (entries === undefined) continue;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          const event = entry && entry.event !== undefined ? entry.event : entry;
          if (event === null || typeof event !== 'object' || event.type !== 'request/header') continue;
          const config = event.data && event.data.header ? event.data.header.config : undefined;
          const maxTokens = config ? count(config.maxTokens) : undefined;
          // The newest header decides; an undeclared cap means no reservation.
          return maxTokens !== undefined && maxTokens > 0 ? maxTokens : undefined;
        }
      }
      return undefined;
    }

    /**
     * Build one display reading for a Session, or null when it cannot be proven.
     * @param ctx - Client root context.
     * @param sessionId - Session rendered by the composer.
     * @returns `{ band, level, percent, remaining, used, contextWindow, threshold }`.
     */
    function readMeter(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      let binding;
      try {
        binding = ctx.sessions.binding(sessionId);
      } catch (error) {
        warnOnce('could not resolve the session binding: ' + (error && error.message));
        return null;
      }
      const session = binding && binding.session;
      if (!session) return null;
      const projections = session.projections;
      if (!projections || typeof projections.faceOf !== 'function') return null;

      let pressure;
      try {
        const face = projections.faceOf('contextPressure');
        pressure = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : undefined;
      } catch (error) {
        warnOnce('could not read the contextPressure projection: ' + (error && error.message));
        return null;
      }
      // No sample yet (a brand-new session): nothing to show, and not an error.
      if (pressure === null || typeof pressure !== 'object') return null;

      // DSH's own ring meter picks projectedTokens first: it is the newest usage
      // sample plus the surface's signed movement since, so a compaction or a
      // fresh tool result does not leave a stale reading on screen.
      const used = count(pressure.projectedTokens) ?? count(pressure.pressureTokens);
      const contextWindow = count(pressure.contextWindow);
      if (used === undefined || contextWindow === undefined || contextWindow <= 0) return null;

      let reserve;
      try {
        reserve = readOutputReserve(session);
      } catch (error) {
        reserve = undefined;
      }
      const threshold = compactionThreshold(contextWindow, reserve);
      if (!Number.isFinite(threshold) || threshold <= 0) {
        warnOnce('the compaction threshold resolved to ' + threshold);
        return null;
      }

      const ratio = used / threshold;
      return {
        band: bandOf(ratio).id,
        level: levelOf(ratio),
        // Two distances, no percentage: the host already shows a percentage of the
        // window, and a second percentage on the same screen reads as a bug.
        toCompact: Math.max(0, threshold - used),
        toLimit: Math.max(0, contextWindow - used),
        used,
        contextWindow,
        threshold,
      };
    }

    /** The active locale id, defaulting to the source language. */
    function currentLanguage(ctx) {
      try {
        const snapshot = ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined;
        const active = snapshot && snapshot.active;
        if (typeof active === 'string' && active !== '') return active;
      } catch (error) {
        // Fall through to the source language.
      }
      return 'zh';
    }

    /** Replace `{name}` placeholders without pulling in a formatter. */
    function interpolate(text, params) {
      if (params === undefined) return text;
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));
    }

    /**
     * Translation seat: the slot's locale service when present, else the built-in
     * dictionary, always with local interpolation so params survive the fallback.
     */
    function makeTranslate(t, language) {
      const dictionary = String(language).toLowerCase().startsWith('zh') ? zh : en;
      return (key, params) => {
        if (typeof t === 'function') {
          try {
            const value = t(key, params);
            // A seat that has not picked up this namespace echoes the key back;
            // treat that as missing so the built-in copy renders instead.
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          } catch (error) {
            // Fall through to the built-in copy.
          }
        }
        const template = dictionary[key];
        if (template === undefined) return '';
        return interpolate(template, params);
      };
    }

    /**
     * Remaining tokens as the locale writes them: 万 for Chinese, k for English.
     * @param tokens - free budget below the compaction threshold.
     * @param translate - locale seat.
     * @param language - active locale id.
     */
    function formatRemaining(tokens, translate, language) {
      const chinese = String(language).toLowerCase().startsWith('zh');
      const scale = chinese ? 10000 : 1000;
      if (tokens < scale) return translate('unit.under');
      return translate('unit.value', { value: Math.floor(tokens / scale) });
    }

    /**
     * Keep watching one Session: the pressure projection drives the value, the
     * locale service re-renders a switched language. A Session that is not bound
     * yet is retried for a bounded time instead of rendering a permanent blank.
     * @param ctx - Client root context.
     * @param sessionId - Session rendered by the composer.
     * @param listener - invalidation callback.
     * @returns disposer of the timer and both subscriptions.
     */
    function watchSession(ctx, sessionId, listener) {
      if (typeof sessionId !== 'string' || sessionId === '') return () => {};
      let stopPressure;
      let attempt = 0;
      let timer = 0;
      let disposed = false;

      const attach = () => {
        if (disposed) return;
        let face;
        try {
          const binding = ctx.sessions.binding(sessionId);
          const session = binding && binding.session;
          const projections = session && session.projections;
          face = projections && typeof projections.faceOf === 'function' ? projections.faceOf('contextPressure') : undefined;
        } catch (error) {
          face = undefined;
        }
        if (face && typeof face.subscribe === 'function') {
          stopPressure = face.subscribe(listener);
          listener();
          return;
        }
        attempt += 1;
        if (attempt > ATTACH_RETRY_LIMIT) return;
        timer = setTimeout(attach, ATTACH_RETRY_MS);
      };
      attach();

      let stopLocale;
      try {
        if (ctx.locale && typeof ctx.locale.subscribe === 'function') stopLocale = ctx.locale.subscribe(listener);
      } catch (error) {
        stopLocale = undefined;
      }

      return () => {
        disposed = true;
        if (timer !== 0) clearTimeout(timer);
        if (typeof stopPressure === 'function') stopPressure();
        if (typeof stopLocale === 'function') stopLocale();
      };
    }

    /**
     * The reading itself: one span, no control, no focus target. Its `title`
     * carries exactly one sentence — the numbers already sit in the line.
     * @param props - injected session seat plus the slot's locale seat.
     */
    function ContextMeter({ sessionId, meterId, read, watch, language, t }) {
      const [, bump] = React.useState(0);
      // Two delivery paths, one truth: a session-scope slot gets `sessionId` as a
      // prop, and `inject(sessionId)` gets the same value at registration time.
      const id = typeof sessionId === 'string' && sessionId !== ''
        ? sessionId
        : typeof meterId === 'string' && meterId !== ''
          ? meterId
          : undefined;

      React.useEffect(() => {
        if (typeof watch !== 'function' || id === undefined) return undefined;
        let alive = true;
        const stop = watch(id, () => {
          if (alive) bump((value) => value + 1);
        });
        return () => {
          alive = false;
          if (typeof stop === 'function') stop();
        };
      }, [id]);

      if (typeof read !== 'function' || id === undefined) return null;
      const reading = read(id);
      if (reading === null || reading === undefined) return null;

      const active = typeof language === 'function' ? language() : language;
      const translate = makeTranslate(t, active);
      const head = translate('tier.' + reading.band);
      const hint = translate('hint.' + reading.band);
      const toCompact = translate('meter.toCompact', {
        value: formatRemaining(reading.toCompact, translate, active),
      });
      const toLimit = translate('meter.toLimit', {
        value: formatRemaining(reading.toLimit, translate, active),
      });
      const label = translate('meter.line', {
        head,
        toCompact,
        toLimit,
      });
      if (head === '' || label === '') return null;

      return h(
        'span',
        {
          className: 'dsh-context-meter',
          'data-context-meter': reading.band,
          'data-level': reading.level,
          title: hint,
          'aria-label': hint,
        },
        label,
      );
    }

    /** Services needed for the Session's projections and the locale seat. */
    const inject = ['slots', 'locale', 'sessions'];

    /**
     * Register the dictionaries, the one stylesheet, and the composer reading.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-meter: dictionaries');

      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-context-meter';
        style.dataset.pluginCss = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, 'context-meter: styles');

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'context-meter',
        label: 'Context Meter',
        order: 40,
        locale: NS,
        inject: (sessionId) => ({
          meterId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined,
          read: (id) => readMeter(ctx, id),
          watch: (id, listener) => watchSession(ctx, id, listener),
          language: () => currentLanguage(ctx),
        }),
      }, ContextMeter));
    }

    return { inject, apply };
  },
});
