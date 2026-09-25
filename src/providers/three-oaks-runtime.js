const BUY_FN = 'app.board.buyFeature.actBuyFeature';
const BOOSTER_NAMES = [
  'activateShopOption',
  'selectShopOption',
  'playShopOption',
  'activateBooster',
  'selectBooster',
];

function compactSource(fn) {
  try {
    return Function.prototype.toString.call(fn).replace(/\s+/g, '');
  } catch {
    return '';
  }
}

function isUsableFunction(fn) {
  if (typeof fn !== 'function') return false;
  const source = compactSource(fn);
  return source && !/\{\}$/.test(source);
}

export async function inspectThreeOaksRuntime(page) {
  return page.evaluate((boosterNames) => {
    const compactSourceInPage = (fn) => {
      try {
        return Function.prototype.toString.call(fn).replace(/\s+/g, '');
      } catch {
        return '';
      }
    };
    const usable = (fn) => {
      if (typeof fn !== 'function') return false;
      const source = compactSourceInPage(fn);
      return Boolean(source) && !/\{\}$/.test(source);
    };

    const ta = window.TestActions;
    const board = window.app?.board;
    const boosterHooks = [];

    for (const name of boosterNames) {
      let fn;
      try { fn = ta?.[name]; } catch { fn = null; }
      if (usable(fn)) boosterHooks.push(name);
    }

    return {
      documentReadyState: document.readyState,
      buy: {
        ready:
          usable(board?.buyFeature?.actBuyFeature) ||
          usable(board?.buyBonus?.actBuyFeature) ||
          usable(window.app?.buyBonus?.actBuyFeature),
        path: usable(board?.buyFeature?.actBuyFeature)
          ? 'app.board.buyFeature.actBuyFeature'
          : usable(board?.buyBonus?.actBuyFeature)
            ? 'app.board.buyBonus.actBuyFeature'
            : usable(window.app?.buyBonus?.actBuyFeature)
              ? 'app.buyBonus.actBuyFeature'
              : null,
      },
      spin: {
        testActions: usable(ta?.spin),
        board: usable(board?.spin),
      },
      booster: {
        hooks: boosterHooks,
        ready: boosterHooks.length > 0,
      },
      start: {
        testActionsClose: usable(ta?.closeStartScreen),
        appSkip: usable(window.app?.startScreen?.skip),
      },
      popup: {
        testActionsOpen: usable(ta?.openBuyFeaturePopup),
        boardPopupShow: usable(board?.buyFeaturePopup?.show),
      },
    };
  }, BOOSTER_NAMES);
}

export async function waitForThreeOaksCapability(page, task, {
  timeoutMs = 12000,
  pollMs = 200,
} = {}) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < timeoutMs) {
    last = await inspectThreeOaksRuntime(page);

    const ready =
      task.kind === 'buy'
        ? last.buy.ready
        : task.kind === 'booster'
          ? last.booster.ready && (last.spin.testActions || last.spin.board)
          : last.spin.testActions || last.spin.board;

    if (ready) {
      return {
        ready: true,
        waitedMs: Date.now() - started,
        capabilities: last,
      };
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    ready: false,
    waitedMs: Date.now() - started,
    capabilities: last,
  };
}

export async function dismissThreeOaksStart(page, viewport) {
  const result = await page.evaluate(() => {
    const usable = (fn) => {
      if (typeof fn !== 'function') return false;
      try {
        const source = Function.prototype.toString.call(fn).replace(/\s+/g, '');
        return Boolean(source) && !/\{\}$/.test(source);
      } catch {
        return false;
      }
    };

    const ta = window.TestActions;
    if (usable(ta?.closeStartScreen)) {
      try {
        ta.closeStartScreen();
        return { dismissed: true, method: 'TestActions.closeStartScreen' };
      } catch {}
    }

    if (usable(window.app?.startScreen?.skip)) {
      try {
        window.app.startScreen.skip();
        return { dismissed: true, method: 'app.startScreen.skip' };
      } catch {}
    }

    return { dismissed: false, method: null };
  });

  if (result.dismissed) {
    await page.waitForTimeout(500);
    return result;
  }

  await page.mouse.click(viewport.width / 2, viewport.height - 50);
  await page.waitForTimeout(700);
  return { dismissed: true, method: 'viewport_click' };
}

export async function invokeThreeOaksTask(page, task) {
  if (task.kind === 'buy') {
    return page.evaluate(async (mode) => {
      const usable = (fn) => {
        if (typeof fn !== 'function') return false;
        try {
          const source = Function.prototype.toString.call(fn).replace(/\s+/g, '');
          return Boolean(source) && !/\{\}$/.test(source);
        } catch {
          return false;
        }
      };

      const ta = window.TestActions;
      let preparedBy = null;

      try {
        if (usable(ta?.openBuyFeaturePopup)) {
          ta.openBuyFeaturePopup();
          preparedBy = 'TestActions.openBuyFeaturePopup';
          await new Promise((resolve) => setTimeout(resolve, 350));
        } else if (usable(window.app?.board?.buyFeaturePopup?.show)) {
          window.app.board.buyFeaturePopup.show();
          preparedBy = 'app.board.buyFeaturePopup.show';
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      } catch {}

      const candidates = [
        ['app.board.buyFeature.actBuyFeature', window.app?.board?.buyFeature],
        ['app.board.buyBonus.actBuyFeature', window.app?.board?.buyBonus],
        ['app.buyBonus.actBuyFeature', window.app?.buyBonus],
      ];

      for (const [name, owner] of candidates) {
        const fn = owner?.actBuyFeature;
        if (typeof fn !== 'function') continue;

        try {
          if (mode == null) fn.call(owner);
          else fn.call(owner, mode);

          return {
            invoked: true,
            hook: name,
            argument: mode,
            preparedBy,
          };
        } catch {}
      }

      return {
        invoked: false,
        reason: 'buy_method_missing_or_failed',
        argument: mode,
        preparedBy,
      };
    }, task.mode);
  }

  if (task.kind === 'booster') {
    return page.evaluate(({ mode, boosterNames }) => {
      const usable = (fn) => {
        if (typeof fn !== 'function') return false;
        try {
          const source = Function.prototype.toString.call(fn).replace(/\s+/g, '');
          return Boolean(source) && !/\{\}$/.test(source);
        } catch {
          return false;
        }
      };

      const ta = window.TestActions;
      let selectedHook = null;

      for (const name of boosterNames) {
        const fn = ta?.[name];
        if (!usable(fn)) continue;
        try {
          fn.call(ta, mode);
          selectedHook = name;
          break;
        } catch {}
      }

      if (!selectedHook) {
        return { invoked: false, reason: 'booster_hook_missing' };
      }

      try {
        if (usable(ta?.spin)) {
          ta.spin();
          return {
            invoked: true,
            hook: `TestActions.${selectedHook}`,
            spinHook: 'TestActions.spin',
            argument: mode,
          };
        }

        if (usable(window.app?.board?.spin)) {
          window.app.board.spin();
          return {
            invoked: true,
            hook: `TestActions.${selectedHook}`,
            spinHook: 'app.board.spin',
            argument: mode,
          };
        }
      } catch (error) {
        return {
          invoked: false,
          reason: 'booster_spin_failed',
          hook: selectedHook,
          error: error?.message || String(error),
        };
      }

      return {
        invoked: false,
        reason: 'booster_spin_missing',
        hook: selectedHook,
      };
    }, { mode: task.mode, boosterNames: BOOSTER_NAMES });
  }

  if (task.kind === 'spin') {
    return page.evaluate(() => {
      const usable = (fn) => {
        if (typeof fn !== 'function') return false;
        try {
          const source = Function.prototype.toString.call(fn).replace(/\s+/g, '');
          return Boolean(source) && !/\{\}$/.test(source);
        } catch {
          return false;
        }
      };

      const ta = window.TestActions;
      try {
        if (usable(ta?.spin)) {
          ta.spin();
          return { invoked: true, hook: 'TestActions.spin' };
        }
        if (usable(window.app?.board?.spin)) {
          window.app.board.spin();
          return { invoked: true, hook: 'app.board.spin' };
        }
      } catch (error) {
        return {
          invoked: false,
          reason: 'spin_failed',
          error: error?.message || String(error),
        };
      }
      return { invoked: false, reason: 'spin_hook_missing' };
    });
  }

  return { invoked: false, reason: 'unsupported_task' };
}

export async function triggerThreeOaksSpinControl(page, viewport) {
  const direct = await page.evaluate(() => {
    const spinView = window.GR?.UI?.view?.spin;

    try {
      const accessor = spinView?.click;
      if (typeof accessor === 'function') {
        const handler = accessor.call(spinView);
        if (typeof handler === 'function') {
          handler();
          return {
            triggered: true,
            method: 'GR.UI.view.spin.click.handler',
          };
        }

        return {
          triggered: true,
          method: 'GR.UI.view.spin.click',
        };
      }
    } catch {}

    const candidates = [
      ['app.board.spinButton.click', window.app?.board?.spinButton, window.app?.board?.spinButton?.click],
      ['app.board.spinButton.emit', window.app?.board?.spinButton, window.app?.board?.spinButton?.emit],
      ['app.board.spinBtn.click', window.app?.board?.spinBtn, window.app?.board?.spinBtn?.click],
      ['app.board.spinBtn.emit', window.app?.board?.spinBtn, window.app?.board?.spinBtn?.emit],
    ];

    for (const [name, owner, fn] of candidates) {
      if (typeof fn !== 'function') continue;
      try {
        if (name.endsWith('.emit')) fn.call(owner, 'pointertap');
        else fn.call(owner);
        return { triggered: true, method: name };
      } catch {}
    }

    const x = Number(spinView?.x);
    const y = Number(spinView?.y);
    return {
      triggered: false,
      method: null,
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
    };
  });

  if (direct.triggered) {
    return direct;
  }

  if (
    Number.isFinite(direct.x) &&
    Number.isFinite(direct.y) &&
    direct.x >= 0 &&
    direct.x < viewport.width &&
    direct.y >= 0 &&
    direct.y < viewport.height
  ) {
    await page.mouse.click(direct.x, direct.y);
    return {
      triggered: true,
      method: 'GR.UI.view.spin.xy',
      x: direct.x,
      y: direct.y,
    };
  }

  const x = viewport.width - 85;
  const y = Math.round(viewport.height / 2);
  await page.mouse.click(x, y);
  return {
    triggered: true,
    method: 'viewport_spin_fallback',
    x,
    y,
  };
}

export const THREE_OAKS_RUNTIME_BUY_PATH = BUY_FN;
