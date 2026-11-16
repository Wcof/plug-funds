/**
 * 投资工作站 · Client 半边（宿主浏览器的行李在这一半）。
 *
 * 只注册两件事：侧栏入口（sidebar.panellist）与主面板（main）。
 * 面板内容是同源 iframe，指向 Host 半边提供的 /plug-funds/ 静态 SPA。
 * 主题通过 URL 参数透传（?theme=dark|light），只覆盖本次渲染、不写回。
 */
window.__ModuleLoader__.load({
  id: 'plugfunds-investment',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'plugFunds';
    const PANEL_ID = 'plugfunds-investment';
    const ROUTE = '/plug-funds/';

    const COPY = {
      zh: {
        'panel.title': '投资工作站',
        'panel.description': '本地优先的个人投资账本与估值观察。',
        'panel.loading': '正在打开投资工作站…',
        'error.not-built': '前端未构建：包内缺少 web/index.html。请在仓库运行 npm run build 后重启宿主窗口。',
        'error.not-found': '路由未注册：请确认插件已启用。',
        'error.network': '无法连接投资工作站页面，请重试。',
        'error.unknown': '投资工作站加载失败。',
        'action.retry': '重试',
      },
      en: {
        'panel.title': 'Investment Workstation',
        'panel.description': 'Local-first personal investment ledger and valuation watch.',
        'panel.loading': 'Opening the investment workstation…',
        'error.not-built': 'Frontend is not built: web/index.html is missing. Run npm run build in the repository, then restart the host window.',
        'error.not-found': 'Route is not registered. Make sure the plugin is enabled.',
        'error.network': 'Cannot reach the investment workstation page. Try again.',
        'error.unknown': 'The investment workstation failed to load.',
        'action.retry': 'Retry',
      },
    };

    function Icon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props && props.active ? 1.8 : 1.4,
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M13.5 8A5.5 5.5 0 1 1 8 2.5' }),
        h('path', { d: 'M8 2.5A5.5 5.5 0 0 1 13.5 8H8z', fill: 'rgba(128,128,128,.35)', stroke: 'none' }),
      );
    }

    const currentTheme = () => {
      try {
        return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light';
      } catch {
        return 'light';
      }
    };

    function createPanel(t) {
      return function InvestmentPanel() {
        const [state, setState] = React.useState({ kind: 'loading' });
        const requested = React.useRef(false);

        const open = React.useCallback(async () => {
          setState({ kind: 'loading' });
          try {
            const response = await fetch(`${ROUTE}?theme=${currentTheme()}`, { credentials: 'same-origin', cache: 'no-store' });
            if (response.ok) {
              setState({ kind: 'ready' });
              return;
            }
            const code = response.status === 503 ? 'not-built' : response.status === 404 ? 'not-found' : 'unknown';
            setState({ kind: 'error', code });
          } catch {
            setState({ kind: 'error', code: 'network' });
          }
        }, []);

        React.useEffect(() => {
          if (requested.current) return;
          requested.current = true;
          open();
        }, [open]);

        if (state.kind === 'ready') {
          const separator = ROUTE.endsWith('/') ? '' : '/';
          return h('iframe', {
            title: t('panel.title'),
            src: `${ROUTE}${separator}?theme=${currentTheme()}`,
            style: { border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' },
          });
        }

        const text = state.kind === 'error' ? t(`error.${state.code}`) : t('panel.loading');
        return h(
          'div',
          { style: { padding: 24, display: 'grid', gap: 12, maxWidth: 460, color: 'inherit' } },
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('panel.title')),
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.72 } }, t('panel.description')),
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.6 } }, text),
          state.kind === 'error'
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: open,
                  style: {
                    justifySelf: 'start',
                    padding: '6px 14px',
                    borderRadius: 8,
                    border: '1px solid currentColor',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    cursor: 'pointer',
                  },
                },
                t('action.retry'),
              )
            : null,
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, COPY), 'plugfunds:copy');
        const t = ctx.locale.bind(NS);
        const Panel = createPanel(t);
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 32, label: () => t('panel.title'), locale: NS },
            Icon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel),
        );
      },
    };
  },
});
