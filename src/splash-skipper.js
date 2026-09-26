const ALLOW = [
  /^play$/i,
  /^start$/i,
  /^continue$/i,
  /^enter$/i,
  /^launch$/i,
  /^tap\s+(?:to\s+)?(?:play|start|continue)$/i,
  /^click\s+(?:to\s+)?(?:play|start|continue)$/i,
  /^press\s+(?:to\s+)?(?:play|start|continue)$/i,
  /^jugar$/i,
  /^comenzar$/i,
  /^continuar$/i,
  /^entrar$/i,
  /^iniciar$/i,
  /^toca\s+para\s+(?:jugar|comenzar|continuar)$/i,
  /^haz\s+clic\s+para\s+(?:jugar|comenzar|continuar)$/i,
];

const BLOCK = /\b(spin|bet|buy|purchase|autoplay|turbo|bonus|free\s*spins?|gamble|wager|stake|collect|cash|apuesta|apostar|comprar|girar|tirar|cobrar)\b/i;

export function normalizeVisibleText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function isSafeSplashText(value) {
  const text = normalizeVisibleText(value);
  if (!text || BLOCK.test(text)) return false;
  return ALLOW.some((rule) => rule.test(text));
}

async function candidatesInFrame(frame) {
  return frame.locator('button, [role="button"], a, input[type="button"], input[type="submit"]').evaluateAll((nodes) =>
    nodes.slice(0, 250).map((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const text = (node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || node.value || '').replace(/\s+/g, ' ').trim();
      return {
        index,
        text,
        visible: rect.width >= 20 && rect.height >= 16 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0,
        disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }),
  );
}

function scoreCandidate(candidate, viewport) {
  const { rect } = candidate;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = Math.abs(cx - viewport.width / 2) / viewport.width;
  const dy = Math.abs(cy - viewport.height / 2) / viewport.height;
  const centrality = 1 - Math.min(1, (dx + dy) / 1.2);
  const area = Math.min(1, (rect.width * rect.height) / 40000);
  return centrality * 0.75 + area * 0.25;
}

export async function skipSafeSplash(page, {
  maxClicks = 1,
  settleMs = 800,
  timeoutMs = 8000,
  pollMs = 250,
  viewport = { width: 1280, height: 720 },
} = {}) {
  const actions = [];
  const deadline = Date.now() + timeoutMs;

  for (let pass = 0; pass < maxClicks; pass += 1) {
    let chosen = null;

    while (!chosen && Date.now() <= deadline) {
      const safe = [];

      for (const frame of page.frames()) {
        let items;
        try {
          items = await candidatesInFrame(frame);
        } catch {
          continue;
        }

        for (const item of items) {
          if (!item.visible || item.disabled || !isSafeSplashText(item.text)) continue;
          safe.push({
            frame,
            frameUrl: frame.url(),
            ...item,
            score: scoreCandidate(item, viewport),
          });
        }
      }

      safe.sort((a, b) => b.score - a.score);
      chosen = safe[0] || null;
      if (!chosen && Date.now() <= deadline) {
        await page.waitForTimeout(pollMs);
      }
    }

    if (!chosen) break;

    try {
      const locator = chosen.frame.locator('button, [role="button"], a, input[type="button"], input[type="submit"]').nth(chosen.index);
      await locator.click({ timeout: 1500 });
      actions.push({
        pass,
        text: normalizeVisibleText(chosen.text),
        frameUrl: chosen.frameUrl,
        rect: chosen.rect,
        score: Number(chosen.score.toFixed(4)),
      });
      if (settleMs > 0) await page.waitForTimeout(settleMs);
    } catch {
      break;
    }
  }

  return actions;
}
