import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './themes.css';
import './styles.css';
import { getSavedTheme, applyTheme, initFollowOSListener } from './utils/theme';
import { applyFontScale, getSavedFontScale } from './utils/fontScale';
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';
import { PushSubscriptionProvider } from './contexts/PushSubscriptionContext';

// Apply saved theme before first render
applyTheme(getSavedTheme());
// Re-apply when the OS color-scheme preference changes, if on "Follow OS".
initFollowOSListener();
applyFontScale(getSavedFontScale());

// Fix country flag emoji display on Windows/Chromium.
// Font is bundled in public/fonts/ — fully offline, no CDN dependency.
polyfillCountryFlagEmojis('Twemoji Country Flags', './fonts/TwemojiCountryFlags.woff2');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PushSubscriptionProvider>
      <App />
    </PushSubscriptionProvider>
  </StrictMode>
);

// Register service worker for Web Push (requires secure context)
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
