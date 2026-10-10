import { expect, test, type Page } from '@playwright/test';

const SECRET = 'e2e';
const PASSWORD = 'not-to-be-forgotten';

async function createVault(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('new-vault').click();
  await page.getByTestId('vault-name').fill(name);
  await page.getByTestId('create-secret').fill(SECRET);
  await page.getByTestId('create-submit').click();
  await expect(page).toHaveURL(/\/v\/[A-Za-z0-9_-]+$/);
  await expect(page.getByTestId('status')).toContainText('Synced');
  return page.url().split('/v/')[1]!.split('?')[0]!;
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}

/** Whether any stored IndexedDB value or localStorage entry contains `text` in plaintext. */
function plaintextStored(page: Page, vaultId: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ({ vaultId, text }) => {
      const needle = new TextEncoder().encode(text);
      const contains = (hay: Uint8Array): boolean => {
        outer: for (let i = 0; i + needle.length <= hay.length; i++) {
          for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
          return true;
        }
        return false;
      };
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const req = indexedDB.open(`notepad-doc-${vaultId}`);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const get = req.result.transaction('updates', 'readonly').objectStore('updates').getAll();
          get.onsuccess = () => {
            req.result.close();
            resolve(get.result);
          };
        };
      });
      const inIdb = values.some((v) => v instanceof Uint8Array && contains(v));
      return inIdb || (localStorage.getItem('notepad') ?? '').includes(text);
    },
    { vaultId, text },
  );
}

test('share a link to the current file, which only opens on devices that joined', async ({ browser }) => {
  const ctxA = await browser.newContext();
  await ctxA.grantPermissions(['clipboard-read', 'clipboard-write']);
  const a = await ctxA.newPage();
  const vaultId = await createVault(a, 'Links');

  a.once('dialog', (d) => d.accept('Ideas'));
  await a.getByTestId('toggle-sidebar').click();
  await a.getByRole('button', { name: 'New file' }).click();
  await a.getByTestId('sidebar').getByRole('button', { name: 'Ideas.md' }).click();
  await expect(a).toHaveURL(/\?f=/);

  await a.getByTestId('share').click();
  const fileLink = await a.getByTestId('file-link').inputValue();
  expect(fileLink).toBe(a.url());
  expect(fileLink).not.toContain('#');
  await a.getByTestId('copy-file-link').click();
  await expect(a.getByTestId('copy-file-link')).toHaveText('Copied');
  expect(await a.evaluate(() => navigator.clipboard.readText())).toBe(fileLink);
  await a.getByRole('tab', { name: 'Join link' }).click();
  const joinLink = await a.getByTestId('join-link').inputValue();
  await a.keyboard.press('Escape');

  // A device that has not joined gets an explicit error, not a silent redirect.
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await b.goto(fileLink);
  await expect(b.getByTestId('vault-missing')).toBeVisible();
  await expect(b).toHaveURL(fileLink);

  // After joining, the same link opens that file.
  await b.goto(joinLink);
  await expect(b.getByTestId('vault-title')).toContainText('Links');
  await b.goto(fileLink);
  await expect(b.getByTestId('vault-title')).toContainText('Ideas.md');
  expect(b.url()).toContain(`/v/${vaultId}?f=`);

  await ctxA.close();
  await ctxB.close();
});

test('local access control encrypts local state and asks for the password in each new tab', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const vaultId = await createVault(a, 'Private');
  await typeInEditor(a, 'very-private-words');
  await expect(a.getByTestId('status')).toContainText('Synced');
  await expect.poll(() => plaintextStored(a, vaultId, 'very-private-words')).toBe(true);

  // ---- Turn it on ---------------------------------------------------------
  await a.goto('/settings');
  await a.getByTestId('lock-enable').click();
  await expect(a.getByText('You must not forget this password.')).toBeVisible();
  await a.getByTestId('lock-password').fill(PASSWORD);
  await a.getByTestId('lock-password-repeat').fill(PASSWORD);
  await expect(a.getByTestId('lock-submit')).toBeDisabled();
  await a.getByTestId('lock-understood').check();
  await a.getByTestId('lock-submit').click();
  // This tab stays unlocked, but the key is not written anywhere.
  await expect(a.getByTestId('local-access')).toContainText('On.');
  const sessionKeys = await a.evaluate(() => Object.keys(sessionStorage));
  expect(sessionKeys.every((k) => /^notepad:(sessionId|wsFailedAt:)/.test(k))).toBe(true);
  expect(await plaintextStored(a, vaultId, 'very-private-words')).toBe(false);
  expect(await plaintextStored(a, vaultId, 'Private')).toBe(false);
  expect(await a.evaluate(() => localStorage.getItem('notepad'))).toMatch(/^\{"sealed":/);

  // Edits made while protected are stored encrypted too (in-app navigation: a page load would lock).
  await a.getByRole('button', { name: 'Back', exact: true }).click();
  await a.getByRole('button', { name: /Private/ }).click();
  await typeInEditor(a, ' more-hidden-words');
  await expect(a.getByTestId('status')).toContainText('Synced');
  await a.waitForTimeout(300);
  expect(await plaintextStored(a, vaultId, 'more-hidden-words')).toBe(false);

  // ---- A new tab needs the password ----------------------------------------
  const b = await ctx.newPage();
  await b.goto(`/v/${vaultId}`);
  await b.getByTestId('unlock-password').fill('wrong password');
  await b.getByTestId('unlock-submit').click();
  await expect(b.getByText('Wrong password.')).toBeVisible();
  await b.getByTestId('unlock-password').fill(PASSWORD);
  await b.getByTestId('unlock-submit').click();
  await expect(b.getByTestId('vault-title')).toContainText('Private');
  await expect(b.locator('.cm-content')).toContainText('very-private-words more-hidden-words');

  // Reloading forgets the key, and so does logging out.
  await b.reload();
  await expect(b.getByTestId('unlock-password')).toBeVisible();
  await b.getByTestId('unlock-password').fill(PASSWORD);
  await b.getByTestId('unlock-submit').click();
  await b.getByTestId('lock-tab').click();
  await expect(b.getByTestId('unlock-password')).toBeVisible();

  // ---- Turn it off again ---------------------------------------------------
  await a.getByRole('button', { name: 'Back to vaults' }).click();
  await a.getByRole('button', { name: 'Settings' }).click();
  await a.getByRole('button', { name: 'Turn off…' }).click();
  await a.getByLabel('Local password').fill(PASSWORD);
  await a.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(a.getByTestId('lock-enable')).toBeVisible();
  // The other tab follows along and no longer asks for a password.
  await expect(b.getByTestId('unlock-password')).toBeHidden();
  await a.goto(`/v/${vaultId}`);
  await expect(a.locator('.cm-content')).toContainText('very-private-words more-hidden-words');
  await expect.poll(() => plaintextStored(a, vaultId, 'Private')).toBe(true);

  await ctx.close();
});
