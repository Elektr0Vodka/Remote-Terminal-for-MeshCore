import {
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useRef,
  useMemo,
  useEffect,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Smile } from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { toast } from './ui/sonner';
import { cn } from '@/lib/utils';

// ─── Emoji picker data ───────────────────────────────────────────────────────

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: 'Smileys',
    emojis: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '😂',
      '🤣',
      '😊',
      '😇',
      '🙂',
      '🙃',
      '😉',
      '😌',
      '😍',
      '🥰',
      '😘',
      '😗',
      '😙',
      '😚',
      '😋',
      '😛',
      '😜',
      '🤪',
      '😝',
      '🤑',
      '🤗',
      '🤭',
      '🤫',
      '🤔',
      '🤐',
      '🥴',
      '😶',
      '😑',
      '😬',
      '🙄',
      '😯',
      '😦',
      '😧',
      '😮',
      '😲',
      '😴',
      '🤤',
      '😪',
      '😵',
      '🤯',
      '🤠',
      '🥳',
      '😎',
      '🤓',
      '🧐',
    ],
  },
  {
    label: 'Feelings',
    emojis: [
      '😕',
      '😟',
      '🙁',
      '☹️',
      '😣',
      '😖',
      '😫',
      '😩',
      '🥺',
      '😢',
      '😭',
      '😤',
      '😠',
      '😡',
      '🤬',
      '😈',
      '👿',
      '💀',
      '☠️',
      '💩',
      '🤡',
      '👹',
      '👺',
      '👻',
      '👽',
      '👾',
      '🤖',
      '😺',
      '😸',
      '😹',
      '😻',
      '😼',
      '😽',
      '🙀',
      '😿',
      '😾',
    ],
  },
  {
    label: 'Gestures',
    emojis: [
      '👋',
      '🤚',
      '🖐️',
      '✋',
      '🖖',
      '👌',
      '🤌',
      '🤏',
      '✌️',
      '🤞',
      '🤟',
      '🤘',
      '🤙',
      '👈',
      '👉',
      '👆',
      '🖕',
      '👇',
      '☝️',
      '👍',
      '👎',
      '✊',
      '👊',
      '🤛',
      '🤜',
      '👏',
      '🙌',
      '👐',
      '🤲',
      '🤝',
      '🙏',
      '✍️',
      '💅',
      '🤳',
      '💪',
      '🦾',
      '🦵',
      '🦶',
      '👂',
      '🦻',
      '👃',
    ],
  },
  {
    label: 'People',
    emojis: [
      '🧑',
      '👦',
      '👧',
      '👨',
      '👩',
      '🧒',
      '👴',
      '👵',
      '🧓',
      '👶',
      '🧑‍💻',
      '👨‍💻',
      '👩‍💻',
      '🧑‍🔧',
      '👨‍🔧',
      '👩‍🔧',
      '🧑‍🚀',
      '👨‍🚀',
      '👩‍🚀',
      '🧑‍⚕️',
      '👮',
      '💂',
      '🕵️',
      '👷',
      '🤴',
      '👸',
      '🧙',
      '🧝',
      '🧛',
      '🧟',
      '🧞',
      '🧜',
      '🧚',
      '👼',
      '🎅',
      '🤶',
      '🦸',
      '🦹',
    ],
  },
  {
    label: 'Animals',
    emojis: [
      '🐶',
      '🐱',
      '🐭',
      '🐹',
      '🐰',
      '🦊',
      '🐻',
      '🐼',
      '🐨',
      '🐯',
      '🦁',
      '🐮',
      '🐷',
      '🐸',
      '🐵',
      '🙈',
      '🙉',
      '🙊',
      '🐔',
      '🐧',
      '🐦',
      '🐤',
      '🦆',
      '🦅',
      '🦉',
      '🦇',
      '🐺',
      '🐗',
      '🐴',
      '🦄',
      '🐝',
      '🐛',
      '🦋',
      '🐌',
      '🐞',
      '🐜',
      '🦟',
      '🦗',
      '🕷️',
      '🦂',
      '🐢',
      '🐍',
      '🦎',
      '🦖',
      '🦕',
      '🐙',
      '🦑',
      '🦐',
      '🦞',
      '🦀',
      '🐡',
      '🐠',
      '🐟',
      '🐬',
      '🐳',
      '🐋',
      '🦈',
      '🐊',
      '🐅',
      '🐆',
    ],
  },
  {
    label: 'Food',
    emojis: [
      '🍎',
      '🍐',
      '🍊',
      '🍋',
      '🍌',
      '🍉',
      '🍇',
      '🍓',
      '🫐',
      '🍈',
      '🍒',
      '🍑',
      '🥭',
      '🍍',
      '🥥',
      '🥝',
      '🍅',
      '🍆',
      '🥑',
      '🥦',
      '🥬',
      '🥒',
      '🌽',
      '🌶️',
      '🫑',
      '🧄',
      '🧅',
      '🥔',
      '🍠',
      '🥐',
      '🥯',
      '🍞',
      '🥖',
      '🥨',
      '🧀',
      '🥚',
      '🍳',
      '🧈',
      '🥞',
      '🧇',
      '🥓',
      '🥩',
      '🍗',
      '🍖',
      '🦴',
      '🌭',
      '🍔',
      '🍟',
      '🍕',
      '🫓',
      '🥙',
      '🧆',
      '🌮',
      '🌯',
      '🥗',
      '🥘',
      '🫕',
      '🍝',
      '🍜',
      '🍲',
      '🍛',
      '🍣',
      '🍱',
      '🥟',
      '🦪',
      '🍤',
      '🍙',
      '🍚',
      '🍘',
      '🍥',
      '🥮',
      '🍢',
      '🧁',
      '🍰',
      '🎂',
      '🍮',
      '🍭',
      '🍬',
      '🍫',
      '🍿',
      '🍩',
      '🍪',
      '🌰',
      '🥜',
      '🍯',
      '🧃',
      '🥤',
      '🧋',
      '🍵',
      '☕',
      '🍺',
      '🍻',
      '🥂',
      '🍷',
      '🥃',
      '🍸',
      '🍹',
    ],
  },
  {
    label: 'Travel',
    emojis: [
      '🚗',
      '🚕',
      '🚙',
      '🚌',
      '🚎',
      '🏎️',
      '🚓',
      '🚑',
      '🚒',
      '🚐',
      '🛻',
      '🚚',
      '🚛',
      '🚜',
      '🛵',
      '🏍️',
      '🛺',
      '🚲',
      '🛴',
      '🛹',
      '🛼',
      '🚏',
      '🛣️',
      '🛤️',
      '⛽',
      '🚨',
      '🚥',
      '🚦',
      '🛑',
      '🚧',
      '⚓',
      '🛟',
      '⛵',
      '🛶',
      '🚤',
      '🛳️',
      '⛴️',
      '🛥️',
      '🚢',
      '✈️',
      '🛩️',
      '🛫',
      '🛬',
      '🪂',
      '💺',
      '🚁',
      '🚟',
      '🚠',
      '🚡',
      '🛰️',
      '🚀',
      '🛸',
      '🪐',
      '🌍',
      '🌎',
      '🌏',
      '🗺️',
      '🧭',
      '🏔️',
      '⛰️',
      '🌋',
      '🗻',
      '🏕️',
      '🏖️',
      '🏜️',
      '🏝️',
      '🏞️',
      '🏟️',
      '🏛️',
      '🏗️',
      '🧱',
      '🏘️',
      '🏚️',
      '🏠',
      '🏡',
      '🏢',
      '🏣',
      '🏤',
      '🏥',
      '🏦',
      '🏨',
      '🏩',
      '🏪',
      '🏫',
      '🏬',
      '🏭',
      '🏯',
      '🏰',
      '💒',
      '🗼',
      '🗽',
      '⛪',
      '🕌',
      '🛕',
      '🕍',
      '⛩️',
      '🕋',
      '⛲',
      '⛺',
      '🌁',
      '🌃',
      '🏙️',
      '🌄',
      '🌅',
      '🌆',
      '🌇',
      '🌉',
      '♨️',
      '🎠',
      '🛝',
      '🎡',
      '🎢',
      '💈',
      '🎪',
    ],
  },
  {
    label: 'Objects',
    emojis: [
      '⌚',
      '📱',
      '💻',
      '⌨️',
      '🖥️',
      '🖨️',
      '🖱️',
      '🖲️',
      '💽',
      '💾',
      '💿',
      '📀',
      '📷',
      '📸',
      '📹',
      '🎥',
      '📽️',
      '🎞️',
      '📞',
      '☎️',
      '📟',
      '📠',
      '📺',
      '📻',
      '🧭',
      '⏱️',
      '⏰',
      '⏲️',
      '⏳',
      '⌛',
      '🔦',
      '💡',
      '🔌',
      '🔋',
      '🪫',
      '🔭',
      '🔬',
      '🩺',
      '🩻',
      '💊',
      '🩹',
      '🩺',
      '🧬',
      '🦠',
      '🧫',
      '🧪',
      '🌡️',
      '🔩',
      '🪛',
      '🔧',
      '🪚',
      '🔨',
      '⚒️',
      '🛠️',
      '⛏️',
      '🔑',
      '🗝️',
      '🔐',
      '🔒',
      '🔓',
      '🚪',
      '🧲',
      '🪝',
      '🪜',
      '🧰',
      '📦',
      '📫',
      '📪',
      '📬',
      '📭',
      '📮',
      '📯',
      '📢',
      '📣',
      '🔔',
      '🔕',
      '🔇',
      '🔈',
      '🔉',
      '🔊',
      '📡',
      '🎵',
      '🎶',
      '🎤',
      '🎧',
      '📻',
      '🎷',
      '🪗',
      '🎸',
      '🎹',
      '🎺',
      '🎻',
      '🥁',
      '🪘',
      '🎙️',
    ],
  },
  {
    label: 'Symbols',
    emojis: [
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🖤',
      '🤍',
      '🤎',
      '💔',
      '❣️',
      '💕',
      '💞',
      '💓',
      '💗',
      '💖',
      '💘',
      '💝',
      '💟',
      '☮️',
      '✝️',
      '☪️',
      '🕉️',
      '☸️',
      '✡️',
      '🔯',
      '🕎',
      '☯️',
      '☦️',
      '🛐',
      '⛎',
      '♈',
      '♉',
      '♊',
      '♋',
      '♌',
      '♍',
      '♎',
      '♏',
      '♐',
      '♑',
      '♒',
      '♓',
      '🆔',
      '⚛️',
      '🉑',
      '☢️',
      '☣️',
      '📴',
      '📳',
      '🈶',
      '🈚',
      '🈸',
      '🈺',
      '🈷️',
      '✴️',
      '🆚',
      '💮',
      '🉐',
      '㊙️',
      '㊗️',
      '🈴',
      '🈵',
      '🈹',
      '🈲',
      '🅰️',
      '🅱️',
      '🆎',
      '🆑',
      '🅾️',
      '🆘',
      '❌',
      '⭕',
      '🛑',
      '⛔',
      '📛',
      '🚫',
      '💯',
      '❗',
      '❕',
      '❓',
      '❔',
      '‼️',
      '⁉️',
      '🔅',
      '🔆',
      '🔱',
      '⚜️',
      '🔰',
      '♻️',
      '✅',
      '🈯',
      '💹',
      '❇️',
      '✳️',
      '❎',
      '🌐',
      '💠',
      'Ⓜ️',
      '🌀',
      '💤',
      '🏧',
      '🚾',
      '♿',
      '🅿️',
      '🛗',
      '🈳',
      '🈹',
      '🚳',
      '🚭',
      '🚯',
      '🚱',
      '🚷',
      '📵',
      '🔞',
      '🔃',
      '🔄',
      '🔙',
      '🔚',
      '🔛',
      '🔜',
      '🔝',
      '🛐',
      '🔀',
      '🔁',
      '🔂',
      '▶️',
      '⏩',
      '⏭️',
      '⏯️',
      '◀️',
      '⏪',
      '⏮️',
      '🔼',
      '⏫',
      '🔽',
      '⏬',
      '⏸️',
      '⏹️',
      '⏺️',
      '🎦',
      '🔅',
      '🔆',
      '📶',
      '📳',
      '📴',
      '🔇',
      '🔈',
      '🔉',
      '🔊',
      '📢',
      '📣',
      '🛎️',
      '🔔',
      '🔕',
      '🎵',
      '🎶',
      '💹',
      '🏧',
      '💲',
      '💱',
      '✔️',
      '☑️',
      '🔘',
      '🔴',
      '🟠',
      '🟡',
      '🟢',
      '🔵',
      '🟣',
      '⚫',
      '⚪',
      '🟤',
      '🔺',
      '🔻',
      '🔷',
      '🔶',
      '🔹',
      '🔸',
      '🔲',
      '🔳',
      '▪️',
      '▫️',
      '◾',
      '◽',
      '◼️',
      '◻️',
      '🟥',
      '🟧',
      '🟨',
      '🟩',
      '🟦',
      '🟪',
      '⬛',
      '⬜',
      '🟫',
      '🔈',
      '🔉',
      '🔊',
      '📣',
      '🔔',
      '➕',
      '➖',
      '➗',
      '✖️',
      '♾️',
      '💲',
      '💱',
      '™️',
      '©️',
      '®️',
      '〰️',
      '➰',
      '➿',
      '🔚',
      '🔛',
      '🔜',
      '🔝',
      '🔙',
      '◀️',
      '▶️',
      '🔼',
      '🔽',
      '↗️',
      '↘️',
      '↙️',
      '↖️',
      '↕️',
      '↔️',
      '↩️',
      '↪️',
      '⤴️',
      '⤵️',
      '🔄',
      '🔃',
      '🌐',
      '⚕️',
      '♻️',
      '⚜️',
      '🔰',
      '✅',
      '❌',
      '❎',
      '🌀',
      '🔱',
    ],
  },
  {
    label: 'Flags',
    emojis: [
      '🏳️',
      '🏴',
      '🚩',
      '🎌',
      '🏁',
      '🏳️‍🌈',
      '🏳️‍⚧️',
      '🏴‍☠️',
      '🇦🇫',
      '🇦🇱',
      '🇩🇿',
      '🇦🇩',
      '🇦🇴',
      '🇦🇬',
      '🇦🇷',
      '🇦🇲',
      '🇦🇺',
      '🇦🇹',
      '🇦🇿',
      '🇧🇸',
      '🇧🇭',
      '🇧🇩',
      '🇧🇧',
      '🇧🇾',
      '🇧🇪',
      '🇧🇿',
      '🇧🇯',
      '🇧🇹',
      '🇧🇴',
      '🇧🇦',
      '🇧🇼',
      '🇧🇷',
      '🇧🇳',
      '🇧🇬',
      '🇧🇫',
      '🇧🇮',
      '🇨🇻',
      '🇰🇭',
      '🇨🇲',
      '🇨🇦',
      '🇨🇫',
      '🇹🇩',
      '🇨🇱',
      '🇨🇳',
      '🇨🇴',
      '🇰🇲',
      '🇨🇬',
      '🇨🇩',
      '🇨🇷',
      '🇭🇷',
      '🇨🇺',
      '🇨🇾',
      '🇨🇿',
      '🇩🇰',
      '🇩🇯',
      '🇩🇲',
      '🇩🇴',
      '🇪🇨',
      '🇪🇬',
      '🇸🇻',
      '🇬🇶',
      '🇪🇷',
      '🇪🇪',
      '🇸🇿',
      '🇪🇹',
      '🇫🇯',
      '🇫🇮',
      '🇫🇷',
      '🇬🇦',
      '🇬🇲',
      '🇬🇪',
      '🇩🇪',
      '🇬🇭',
      '🇬🇷',
      '🇬🇩',
      '🇬🇹',
      '🇬🇳',
      '🇬🇼',
      '🇬🇾',
      '🇭🇹',
      '🇭🇳',
      '🇭🇺',
      '🇮🇸',
      '🇮🇳',
      '🇮🇩',
      '🇮🇷',
      '🇮🇶',
      '🇮🇪',
      '🇮🇱',
      '🇮🇹',
      '🇯🇲',
      '🇯🇵',
      '🇯🇴',
      '🇰🇿',
      '🇰🇪',
      '🇰🇮',
      '🇰🇵',
      '🇰🇷',
      '🇽🇰',
      '🇰🇼',
      '🇰🇬',
      '🇱🇦',
      '🇱🇻',
      '🇱🇧',
      '🇱🇸',
      '🇱🇷',
      '🇱🇾',
      '🇱🇮',
      '🇱🇹',
      '🇱🇺',
      '🇲🇬',
      '🇲🇼',
      '🇲🇾',
      '🇲🇻',
      '🇲🇱',
      '🇲🇹',
      '🇲🇭',
      '🇲🇷',
      '🇲🇺',
      '🇲🇽',
      '🇫🇲',
      '🇲🇩',
      '🇲🇨',
      '🇲🇳',
      '🇲🇪',
      '🇲🇦',
      '🇲🇿',
      '🇲🇲',
      '🇳🇦',
      '🇳🇷',
      '🇳🇵',
      '🇳🇱',
      '🇳🇿',
      '🇳🇮',
      '🇳🇪',
      '🇳🇬',
      '🇲🇰',
      '🇳🇴',
      '🇴🇲',
      '🇵🇰',
      '🇵🇼',
      '🇵🇸',
      '🇵🇦',
      '🇵🇬',
      '🇵🇾',
      '🇵🇪',
      '🇵🇭',
      '🇵🇱',
      '🇵🇹',
      '🇶🇦',
      '🇷🇴',
      '🇷🇺',
      '🇷🇼',
      '🇰🇳',
      '🇱🇨',
      '🇻🇨',
      '🇼🇸',
      '🇸🇲',
      '🇸🇹',
      '🇸🇦',
      '🇸🇳',
      '🇷🇸',
      '🇸🇱',
      '🇸🇬',
      '🇸🇰',
      '🇸🇮',
      '🇸🇧',
      '🇸🇴',
      '🇿🇦',
      '🇸🇸',
      '🇪🇸',
      '🇱🇰',
      '🇸🇩',
      '🇸🇷',
      '🇸🇪',
      '🇨🇭',
      '🇸🇾',
      '🇹🇼',
      '🇹🇯',
      '🇹🇿',
      '🇹🇭',
      '🇹🇱',
      '🇹🇬',
      '🇹🇴',
      '🇹🇹',
      '🇹🇳',
      '🇹🇷',
      '🇹🇲',
      '🇺🇬',
      '🇺🇦',
      '🇦🇪',
      '🇬🇧',
      '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
      '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
      '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
      '🇺🇸',
      '🇺🇾',
      '🇺🇿',
      '🇻🇺',
      '🇻🇦',
      '🇻🇪',
      '🇻🇳',
      '🇾🇪',
      '🇿🇲',
      '🇿🇼',
    ],
  },
];

// MeshCore message size limits (empirically determined from LoRa packet constraints)
// Direct delivery allows ~156 bytes; multi-hop requires buffer for path growth.
// Channels include "sender: " prefix in the encrypted payload.
// All limits are in bytes (UTF-8), not characters, since LoRa packets are byte-constrained.
const DM_HARD_LIMIT = 156; // Max bytes for direct delivery
const DM_WARNING_THRESHOLD = 140; // Conservative for multi-hop
const CHANNEL_HARD_LIMIT = 156; // Base byte limit before sender overhead
const CHANNEL_WARNING_THRESHOLD = 120; // Conservative for multi-hop
const CHANNEL_DANGER_BUFFER = 8; // Red zone starts this many bytes before hard limit

const textEncoder = new TextEncoder();
const RADIO_NO_RESPONSE_SNIPPET = 'no response was heard back';
/** Get UTF-8 byte length of a string (LoRa packets are byte-constrained, not character-constrained). */
function byteLen(s: string): number {
  return textEncoder.encode(s).length;
}

interface MessageInputProps {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  placeholder?: string;
  /** Conversation type for character limit calculation */
  conversationType?: 'contact' | 'channel' | 'raw';
  /** Sender name (radio name) for channel message limit calculation */
  senderName?: string;
}

type LimitState = 'normal' | 'warning' | 'danger' | 'error';

export interface MessageInputHandle {
  appendText: (text: string) => void;
  focus: () => void;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  { onSend, disabled, placeholder, conversationType, senderName },
  ref
) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        pickerRef.current &&
        !pickerRef.current.contains(e.target as Node) &&
        !emojiButtonRef.current?.contains(e.target as Node)
      ) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEmojiPicker]);

  const insertEmoji = useCallback(
    (emoji: string) => {
      const input = inputRef.current;
      if (!input) {
        setText((prev) => prev + emoji);
        return;
      }
      const start = input.selectionStart ?? text.length;
      const end = input.selectionEnd ?? text.length;
      const next = text.slice(0, start) + emoji + text.slice(end);
      setText(next);
      // Restore cursor after the inserted emoji
      const newPos = start + emoji.length;
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(newPos, newPos);
      });
    },
    [text]
  );

  useImperativeHandle(ref, () => ({
    appendText: (appendedText: string) => {
      setText((prev) => prev + appendedText);
      // Focus the input after appending
      inputRef.current?.focus();
    },
    focus: () => {
      inputRef.current?.focus();
    },
  }));

  // Calculate character limits based on conversation type
  const limits = useMemo(() => {
    if (conversationType === 'contact') {
      return {
        warningAt: DM_WARNING_THRESHOLD,
        dangerAt: DM_HARD_LIMIT, // Same as hard limit for DMs (no intermediate red zone)
        hardLimit: DM_HARD_LIMIT,
      };
    } else if (conversationType === 'channel') {
      // Channel hard limit = 156 bytes - senderName bytes - 2 (for ": " separator)
      const nameByteLen = senderName ? byteLen(senderName) : 10;
      const hardLimit = Math.max(1, CHANNEL_HARD_LIMIT - nameByteLen - 2);
      return {
        warningAt: CHANNEL_WARNING_THRESHOLD,
        dangerAt: Math.max(1, hardLimit - CHANNEL_DANGER_BUFFER),
        hardLimit,
      };
    }
    return null; // Raw/other - no limits
  }, [conversationType, senderName]);

  // UTF-8 byte length of the current text (LoRa packets are byte-constrained)
  const textByteLen = useMemo(() => byteLen(text), [text]);

  // Determine current limit state
  const { limitState, warningMessage } = useMemo((): {
    limitState: LimitState;
    warningMessage: string | null;
  } => {
    if (!limits) return { limitState: 'normal', warningMessage: null };

    if (textByteLen >= limits.hardLimit) {
      return { limitState: 'error', warningMessage: 'likely truncated by radio' };
    }
    if (textByteLen >= limits.dangerAt) {
      return { limitState: 'danger', warningMessage: 'may impact multi-repeater hop delivery' };
    }
    if (textByteLen >= limits.warningAt) {
      return { limitState: 'warning', warningMessage: 'may impact multi-repeater hop delivery' };
    }
    return { limitState: 'normal', warningMessage: null };
  }, [textByteLen, limits]);

  const remaining = limits ? limits.hardLimit - textByteLen : 0;

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const trimmed = text.trim();
      if (!trimmed || sending || disabled) return;

      setSending(true);
      try {
        await onSend(trimmed);
        setText('');
      } catch (err) {
        console.error('Failed to send message:', err);
        const description = err instanceof Error ? err.message : 'Check radio connection';
        const isRadioNoResponse =
          err instanceof Error && err.message.toLowerCase().includes(RADIO_NO_RESPONSE_SNIPPET);
        toast.error(isRadioNoResponse ? 'Radio did not confirm send' : 'Failed to send message', {
          description,
        });
        return;
      } finally {
        setSending(false);
      }
      // Refocus after React re-enables the input
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [text, sending, disabled, onSend]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e as unknown as FormEvent);
      }
    },
    [handleSubmit]
  );

  const canSubmit = text.trim().length > 0;

  // Show counter for messages (not raw).
  // Desktop: always visible. Mobile: only show count after 100 characters.
  const showCharCounter = limits !== null;
  const showMobileCounterValue = text.length > 100;

  return (
    <form
      className="message-input-shell relative px-4 py-2.5 border-t border-border flex flex-col gap-1"
      onSubmit={handleSubmit}
      autoComplete="off"
    >
      {/* Emoji picker panel */}
      {showEmojiPicker && (
        <div
          ref={pickerRef}
          className="absolute bottom-full mb-1 right-4 z-50 w-72 rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowEmojiPicker(false);
          }}
        >
          {/* Category tabs */}
          <div className="flex overflow-x-auto border-b border-border bg-background scrollbar-none">
            {EMOJI_CATEGORIES.map((cat, i) => (
              <button
                key={cat.label}
                type="button"
                onClick={() => setEmojiCategory(i)}
                className={cn(
                  'flex-shrink-0 px-2.5 py-1.5 text-[10px] font-medium transition-colors whitespace-nowrap',
                  i === emojiCategory
                    ? 'border-b-2 border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>
          {/* Emoji grid */}
          <div className="grid grid-cols-10 gap-0 p-1 max-h-48 overflow-y-auto">
            {EMOJI_CATEGORIES[emojiCategory].emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => insertEmoji(emoji)}
                className="flex items-center justify-center rounded p-1 text-base hover:bg-accent transition-colors"
                aria-label={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Input
          ref={inputRef}
          type="text"
          autoComplete="off"
          name="chat-message-input"
          aria-label={placeholder || 'Type a message'}
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Type a message...'}
          disabled={disabled || sending}
          className="flex-1 min-w-0"
        />
        <button
          ref={emojiButtonRef}
          type="button"
          disabled={disabled}
          onClick={() => setShowEmojiPicker((p) => !p)}
          aria-label="Insert emoji"
          className={cn(
            'flex-shrink-0 flex items-center justify-center rounded-md border border-input bg-background px-2.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
            showEmojiPicker && 'bg-accent text-foreground'
          )}
        >
          <Smile className="h-4 w-4 text-muted-foreground" />
        </button>
        <Button
          type="submit"
          disabled={disabled || sending || !canSubmit}
          className="flex-shrink-0"
        >
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </div>
      {showCharCounter && (
        <>
          <div className="hidden sm:flex items-center justify-end gap-2 text-xs">
            <span
              className={cn(
                'tabular-nums',
                limitState === 'error' || limitState === 'danger'
                  ? 'text-destructive font-medium'
                  : limitState === 'warning'
                    ? 'text-warning'
                    : 'text-muted-foreground'
              )}
            >
              {textByteLen}/{limits!.hardLimit}
              {remaining < 0 && ` (${remaining})`}
            </span>
            {warningMessage && (
              <span className={cn(limitState === 'error' ? 'text-destructive' : 'text-warning')}>
                — {warningMessage}
              </span>
            )}
          </div>

          {(showMobileCounterValue || warningMessage) && (
            <div className="flex sm:hidden items-center justify-end gap-2 text-xs">
              {showMobileCounterValue && (
                <span
                  className={cn(
                    'tabular-nums',
                    limitState === 'error' || limitState === 'danger'
                      ? 'text-destructive font-medium'
                      : limitState === 'warning'
                        ? 'text-warning'
                        : 'text-muted-foreground'
                  )}
                >
                  {textByteLen}/{limits!.hardLimit}
                  {remaining < 0 && ` (${remaining})`}
                </span>
              )}
              {warningMessage && (
                <span className={cn(limitState === 'error' ? 'text-destructive' : 'text-warning')}>
                  — {warningMessage}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </form>
  );
});
