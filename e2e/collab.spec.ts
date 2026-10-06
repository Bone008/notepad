import { expect, test, type Page } from '@playwright/test';

const SECRET = 'e2e';

async function typeInEditor(page: Page, text: string): Promise<void> {
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

/** Plain document text via the session handle (the editor DOM also contains remote cursor labels). */
async function docText(page: Page): Promise<string> {
  const vaultId = page.url().split('/v/')[1]?.split('?')[0] ?? '';
  return page.evaluate((id) => {
    const s = (window as unknown as { __notepad: { peekSession(id: string): { doc: { getMap(n: string): Map<string, { get(k: string): { toString(): string } }> } } | null } }).__notepad.peekSession(id);
    if (!s) return '';
    let out = '';
    s.doc.getMap('files').forEach((f) => {
      out += f.get('text').toString() + '\n';
    });
    return out;
  }, vaultId);
}

function expectDoc(page: Page) {
  return expect.poll(() => docText(page), { timeout: 15_000 });
}

test('two devices collaborate live, pair by typed code, and fall back to HTTP when WebSockets are blocked', async ({ browser }) => {
  // ---- Device A creates a vault --------------------------------------------
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await a.goto('/');
  await a.getByTestId('new-vault').click();
  await a.getByTestId('vault-name').fill('Team');
  await a.getByTestId('create-secret').fill(SECRET);
  await a.getByTestId('create-submit').click();
  await expect(a).toHaveURL(/\/v\/[A-Za-z0-9_-]+$/);
  await expectDoc(a).toContain('# Team');
  await expect(a.getByTestId('status')).toHaveAttribute('data-transport', 'ws');
  await expect(a.getByTestId('status')).toContainText('Synced');

  await typeInEditor(a, 'Hello from A');
  await expect(a.getByTestId('status')).toContainText('Synced');

  // ---- Device A shows a pairing code; device B types it ---------------------
  await a.getByTestId('share').click();
  const codeEl = a.getByTestId('pairing-code');
  await expect(codeEl).not.toContainText('—');
  const code = (await codeEl.innerText()).trim();
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await b.goto('/');
  await b.getByTestId('join-vault').click();
  // Type it the sloppy way: lowercase with spaces.
  await b.getByTestId('pair-input').fill(code.toLowerCase().replace(/-/g, ' '));
  await b.getByTestId('pair-submit').click();
  await expect(b).toHaveURL(/\/v\/[A-Za-z0-9_-]+$/);
  await expectDoc(b).toContain('Hello from A');
  await expect(b.getByTestId('vault-title')).toContainText('Team');

  // A learns that the code was used.
  await expect(a.getByText('A device joined with this code.')).toBeVisible({ timeout: 15_000 });
  // Grab the join link for device C before closing the dialog.
  await a.getByRole('tab', { name: 'Link' }).click();
  const link = await a.getByTestId('join-link').inputValue();
  expect(link).toMatch(/#join=/);
  await a.keyboard.press('Escape');

  // ---- Live collaboration both ways -----------------------------------------
  await typeInEditor(b, ' and B');
  await expectDoc(a).toContain('Hello from A and B');
  await typeInEditor(a, ' again');
  await expectDoc(b).toContain('Hello from A and B again');

  await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '2');
  await expect(b.getByTestId('presence')).toHaveAttribute('data-count', '2');

  // ---- View mode renders markdown -------------------------------------------
  await b.getByTestId('mode-view').click();
  await expect(b.getByTestId('viewer').locator('h1')).toHaveText('Team');
  await b.getByTestId('mode-code').click();

  // ---- Device C: WebSockets blocked, joins via link ------------------------
  const ctxC = await browser.newContext();
  await ctxC.routeWebSocket(/\/ws$/, (ws) => {
    ws.close({ code: 1006, reason: 'blocked by test' });
  });
  const c = await ctxC.newPage();
  await c.goto(link);
  await expect(c).toHaveURL(/\/v\/[A-Za-z0-9_-]+$/);
  expect(c.url()).not.toContain('#');
  await expectDoc(c).toContain('Hello from A and B again');
  await expect(c.getByTestId('status')).toHaveAttribute('data-transport', 'http');
  await expect(c.getByTestId('status')).toContainText('Synced');

  await typeInEditor(a, ' + C');
  await expectDoc(c).toContain('again + C');
  await typeInEditor(c, ' back');
  await expectDoc(a).toContain('again + C back');
  await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '3');

  // ---- Files: a second file created on B shows up on A and C ----------------
  b.once('dialog', (d) => d.accept('Ideas'));
  await b.getByTestId('toggle-sidebar').click();
  await b.getByRole('button', { name: 'New file' }).click();
  await expect(b.getByTestId('sidebar')).toContainText('Ideas.md');
  await a.getByTestId('toggle-sidebar').click();
  await expect(a.getByTestId('sidebar')).toContainText('Ideas.md');

  // ---- Offline edit on B is queued and delivered after reload ---------------
  await ctxB.setOffline(true);
  await b.getByRole('button', { name: 'Notes.md' }).click(); // sidebar is still open on B
  await typeInEditor(b, ' offline-edit');
  await expect(b.getByTestId('status')).not.toContainText('Synced');
  await ctxB.setOffline(false);
  await expectDoc(a).toContain('offline-edit');
  await expect(b.getByTestId('status')).toContainText('Synced', { timeout: 20_000 });

  const finalA = await docText(a);
  await expect.poll(() => docText(c)).toBe(finalA);
  await expect.poll(() => docText(b)).toBe(finalA);

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});

test('a refreshed tab does not show up twice in presence', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await a.goto('/');
  await a.getByTestId('new-vault').click();
  await a.getByTestId('vault-name').fill('Refresh');
  await a.getByTestId('create-secret').fill(SECRET);
  await a.getByTestId('create-submit').click();
  await expect(a.getByTestId('status')).toContainText('Synced');
  await a.getByTestId('share').click();
  await a.getByRole('tab', { name: 'Link' }).click();
  const link = await a.getByTestId('join-link').inputValue();
  await a.keyboard.press('Escape');

  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await b.goto(link);
  await expect(b.getByTestId('presence')).toHaveAttribute('data-count', '2');
  await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '2');

  for (let i = 0; i < 3; i++) {
    await a.reload();
    await expect(a.getByTestId('status')).toContainText('Synced');
    await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '2');
    await expect(b.getByTestId('presence')).toHaveAttribute('data-count', '2');
  }
  // Still exactly two a moment later (nothing stale lingering).
  await a.waitForTimeout(1500);
  await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '2');
  await expect(b.getByTestId('presence')).toHaveAttribute('data-count', '2');

  await ctxA.close();
  await ctxB.close();
});
