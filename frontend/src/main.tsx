import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './themes.css';
import './styles.css';
import { getSavedTheme, applyTheme } from './utils/theme';
import { applyFontScale, getSavedFontScale } from './utils/fontScale';
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';

// Apply saved theme before first render
applyTheme(getSavedTheme());
applyFontScale(getSavedFontScale());

// Fix country flag emoji display on Windows/Chromium.
// Font is bundled in public/fonts/ — fully offline, no CDN dependency.
polyfillCountryFlagEmojis('Twemoji Country Flags', './fonts/TwemojiCountryFlags.woff2');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
