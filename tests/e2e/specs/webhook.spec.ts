import { test, expect } from '@playwright/test';
import {
  createFanoutConfig,
  deleteFanoutConfig,
  getFanoutConfigs,
} from '../helpers/api';

test.describe('Webhook integration settings', () => {
  let createdWebhookId: string | null = null;

  test.afterEach(async () => {
    if (createdWebhookId) {
      try {
        await deleteFanoutConfig(createdWebhookId);
      } catch {
        console.warn('Failed to delete test webhook');
      }
      createdWebhookId = null;
    }
  });

  test('create webhook via UI, configure, save as enabled, verify in list', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible();

    // Open settings and navigate to MQTT & Automation
    await page.getByText('Settings').click();
    await page.getByRole('button', { name: /MQTT.*Automation/ }).click();

    // Click the Webhook add button
    await page.getByRole('button', { name: 'Webhook' }).click();

    // Should navigate to the detail/edit view with default name
    await expect(page.locator('#fanout-edit-name')).toHaveValue('Webhook');

    // Fill in webhook URL
    const urlInput = page.locator('#fanout-webhook-url');
    await urlInput.fill('https://example.com/e2e-test-hook');

    // Verify method defaults to POST
    await expect(page.locator('#fanout-webhook-method')).toHaveValue('POST');

    // Rename it
    const nameInput = page.locator('#fanout-edit-name');
    await nameInput.clear();
    await nameInput.fill('E2E Webhook');

    // Save as enabled
    await page.getByRole('button', { name: /Save as Enabled/i }).click();
    await expect(page.getByText('Integration saved and enabled')).toBeVisible();

    // Should be back on list view with our webhook visible
    await expect(page.getByText('E2E Webhook')).toBeVisible();

    // Clean up via API
    const configs = await getFanoutConfigs();
    const webhook = configs.find((c) => c.name === 'E2E Webhook');
    if (webhook) {
      createdWebhookId = webhook.id;
    }
  });

  test('create webhook via API, edit in UI, save as disabled', async ({ page }) => {
    // Create via API
    const webhook = await createFanoutConfig({
      type: 'webhook',
      name: 'API Webhook',
      config: { url: 'https://example.com/hook', method: 'POST', headers: {} },
      enabled: true,
    });
    createdWebhookId = webhook.id;

    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible();

    await page.getByText('Settings').click();
    await page.getByRole('button', { name: /MQTT.*Automation/ }).click();

    // Click Edit on our webhook
    const row = page.getByText('API Webhook').locator('..');
    await row.getByRole('button', { name: 'Edit' }).click();

    // Should be in edit view
    await expect(page.locator('#fanout-edit-name')).toHaveValue('API Webhook');

    // Change method to PUT
    await page.locator('#fanout-webhook-method').selectOption('PUT');

    // Save as disabled
    await page.getByRole('button', { name: /Save as Disabled/i }).click();
    await expect(page.getByText('Integration saved')).toBeVisible();

    // Verify it's now disabled in the list
    const configs = await getFanoutConfigs();
    const updated = configs.find((c) => c.id === webhook.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.config.method).toBe('PUT');
  });

  test('webhook shows scope selector with channel/contact options', async ({ page }) => {
    const webhook = await createFanoutConfig({
      type: 'webhook',
      name: 'Scope Webhook',
      config: { url: 'https://example.com/hook', method: 'POST', headers: {} },
    });
    createdWebhookId = webhook.id;

    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible();

    await page.getByText('Settings').click();
    await page.getByRole('button', { name: /MQTT.*Automation/ }).click();

    // Click Edit
    const row = page.getByText('Scope Webhook').locator('..');
    await row.getByRole('button', { name: 'Edit' }).click();

    // Verify scope selector is visible with the three webhook-applicable modes
    await expect(page.getByText('Message Scope')).toBeVisible();
    await expect(page.getByText('All messages')).toBeVisible();
    await expect(page.getByText('Only listed channels/contacts')).toBeVisible();
    await expect(page.getByText('All except listed channels/contacts')).toBeVisible();

    // Select "Only listed" to see channel/contact checkboxes
    await page.getByText('Only listed channels/contacts').click();

    // Should show Channels section (Contacts only appears if non-repeater contacts exist)
    await expect(page.getByText('Channels (include)')).toBeVisible();

    // Go back without saving
    await page.getByText('← Back to list').click();
  });

  test('delete webhook via UI', async ({ page }) => {
    const webhook = await createFanoutConfig({
      type: 'webhook',
      name: 'Delete Me Webhook',
      config: { url: 'https://example.com/hook', method: 'POST', headers: {} },
    });
    createdWebhookId = webhook.id;

    await page.goto('/');
    await expect(page.getByText('Connected')).toBeVisible();

    await page.getByText('Settings').click();
    await page.getByRole('button', { name: /MQTT.*Automation/ }).click();

    // Click Edit
    const row = page.getByText('Delete Me Webhook').locator('..');
    await row.getByRole('button', { name: 'Edit' }).click();

    // Accept the confirmation dialog
    page.on('dialog', (dialog) => dialog.accept());

    // Click Delete
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText('Integration deleted')).toBeVisible();

    // Should be back on list, webhook gone
    await expect(page.getByText('Delete Me Webhook')).not.toBeVisible();

    // Already deleted, clear the cleanup reference
    createdWebhookId = null;
  });
});
