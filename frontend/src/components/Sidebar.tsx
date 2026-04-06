import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownUp,
  BarChart2,
  Bell,
  Bot,
  Cable,
  ChartNetwork,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  GripVertical,
  KeyRound,
  LockOpen,
  Logs,
  Map,
  Search as SearchIcon,
  Settings,
  SquarePen,
  X,
} from 'lucide-react';
import {
  CONTACT_TYPE_ROOM,
  CONTACT_TYPE_REPEATER,
  type Contact,
  type Channel,
  type Conversation,
} from '../types';
import {
  buildSidebarSectionSortOrders,
  getStateKey,
  loadLegacyLocalStorageSortOrder,
  loadLocalStorageSidebarSectionSortOrders,
  saveLocalStorageSidebarSectionSortOrders,
  type ConversationTimes,
  type SidebarSectionSortOrders,
  type SidebarSortableSection,
  type SortOrder,
} from '../utils/conversationState';
import { isPublicChannelKey } from '../utils/publicChannel';
import { getContactDisplayName } from '../utils/pubkey';
import { handleKeyboardActivate } from '../utils/a11y';
import { ContactAvatar } from './ContactAvatar';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

const CONTACT_TYPE_SENSOR = 4;

// ─── Types ──────────────────────────────────────────────────────────────────

type FavoriteItem = { type: 'channel'; channel: Channel } | { type: 'contact'; contact: Contact };

type ConversationRow = {
  key: string;
  type: 'channel' | 'contact';
  id: string;
  name: string;
  unreadCount: number;
  isMention: boolean;
  notificationsEnabled: boolean;
  contact?: Contact;
};

type CollapseState = {
  tools: boolean;
  favorites: boolean;
  owned: boolean;
  channels: boolean;
  contacts: boolean;
  rooms: boolean;
  repeaters: boolean;
  favChannels: boolean;
  favContacts: boolean;
  favRooms: boolean;
  favRepeaters: boolean;
  ownedRepeaters: boolean;
  ownedRooms: boolean;
  ownedSensors: boolean;
};

// ─── Section ordering ────────────────────────────────────────────────────────

type SidebarSection =
  | 'tools'
  | 'favorites'
  | 'owned'
  | 'channels'
  | 'contacts'
  | 'rooms'
  | 'repeaters';

const ALL_SECTIONS: SidebarSection[] = [
  'tools',
  'favorites',
  'owned',
  'channels',
  'contacts',
  'rooms',
  'repeaters',
];

const SECTION_LABELS: Record<SidebarSection, string> = {
  tools: 'Tools',
  favorites: 'Favorites',
  owned: 'Owned',
  channels: 'Channels',
  contacts: 'Contacts',
  rooms: 'Room Servers',
  repeaters: 'Repeaters',
};

const SIDEBAR_SECTION_ORDER_KEY = 'remoteterm-sidebar-section-order';

function loadSectionOrder(): SidebarSection[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTION_ORDER_KEY);
    if (!raw) return [...ALL_SECTIONS];
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((s): s is SidebarSection =>
      ALL_SECTIONS.includes(s as SidebarSection)
    );
    const missing = ALL_SECTIONS.filter((s) => !valid.includes(s));
    return [...valid, ...missing];
  } catch {
    return [...ALL_SECTIONS];
  }
}

function saveSectionOrder(order: SidebarSection[]): void {
  localStorage.setItem(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify(order));
}

// ─── Tool ordering ───────────────────────────────────────────────────────────

type ToolKey =
  | 'packet-feed'
  | 'node-map'
  | 'mesh-visualizer'
  | 'message-search'
  | 'my-node'
  | 'mesh-health'
  | 'room-finder'
  | 'mc-kms'
  | 'trace'
  | 'bot-detector';

const TOOL_LABELS: Record<ToolKey, string> = {
  'packet-feed': 'Packet Feed',
  'node-map': 'Node Map',
  'mesh-visualizer': 'Mesh Visualizer',
  'message-search': 'Message Search',
  'my-node': 'My Node',
  'mesh-health': 'Mesh Health',
  'room-finder': 'Room Finder',
  'mc-kms': 'MC-KMS',
  trace: 'Trace',
  'bot-detector': 'Bot Detector',
};

const ALL_TOOL_KEYS: ToolKey[] = [
  'packet-feed',
  'node-map',
  'mesh-visualizer',
  'message-search',
  'my-node',
  'mesh-health',
  'room-finder',
  'mc-kms',
  'trace',
  'bot-detector',
];

const SIDEBAR_TOOL_ORDER_KEY = 'remoteterm-sidebar-tool-order';

function loadToolOrder(): ToolKey[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_TOOL_ORDER_KEY);
    if (!raw) return [...ALL_TOOL_KEYS];
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((k): k is ToolKey => ALL_TOOL_KEYS.includes(k as ToolKey));
    const missing = ALL_TOOL_KEYS.filter((k) => !valid.includes(k));
    return [...valid, ...missing];
  } catch {
    return [...ALL_TOOL_KEYS];
  }
}

function saveToolOrder(order: ToolKey[]): void {
  localStorage.setItem(SIDEBAR_TOOL_ORDER_KEY, JSON.stringify(order));
}

// ─── Collapse state ──────────────────────────────────────────────────────────

const SIDEBAR_COLLAPSE_STATE_KEY = 'remoteterm-sidebar-collapse-state';

const DEFAULT_COLLAPSE_STATE: CollapseState = {
  tools: false,
  favorites: false,
  owned: false,
  channels: false,
  contacts: false,
  rooms: false,
  repeaters: false,
  favChannels: false,
  favContacts: false,
  favRooms: false,
  favRepeaters: false,
  ownedRepeaters: false,
  ownedRooms: false,
  ownedSensors: false,
};

function loadCollapsedState(): CollapseState {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_STATE_KEY);
    if (!raw) return DEFAULT_COLLAPSE_STATE;
    const parsed = JSON.parse(raw) as Partial<CollapseState>;
    return {
      tools: parsed.tools ?? false,
      favorites: parsed.favorites ?? false,
      owned: parsed.owned ?? false,
      channels: parsed.channels ?? false,
      contacts: parsed.contacts ?? false,
      rooms: parsed.rooms ?? false,
      repeaters: parsed.repeaters ?? false,
      favChannels: parsed.favChannels ?? false,
      favContacts: parsed.favContacts ?? false,
      favRooms: parsed.favRooms ?? false,
      favRepeaters: parsed.favRepeaters ?? false,
      ownedRepeaters: parsed.ownedRepeaters ?? false,
      ownedRooms: parsed.ownedRooms ?? false,
      ownedSensors: parsed.ownedSensors ?? false,
    };
  } catch {
    return DEFAULT_COLLAPSE_STATE;
  }
}

// ─── Drag-and-drop list ──────────────────────────────────────────────────────

function DragList<T extends string>({
  items,
  labels,
  onReorder,
}: {
  items: T[];
  labels: Record<string, string>;
  onReorder: (next: T[]) => void;
}) {
  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const handleDragStart = (i: number) => {
    dragIndex.current = i;
  };

  const handleDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    setOverIndex(i);
  };

  const handleDrop = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    const from = dragIndex.current;
    if (from === null || from === i) {
      dragIndex.current = null;
      setOverIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    dragIndex.current = null;
    setOverIndex(null);
    onReorder(next);
  };

  const handleDragEnd = () => {
    dragIndex.current = null;
    setOverIndex(null);
  };

  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div
          key={item}
          draggable
          onDragStart={() => handleDragStart(i)}
          onDragOver={(e) => handleDragOver(e, i)}
          onDrop={(e) => handleDrop(e, i)}
          onDragEnd={handleDragEnd}
          className={cn(
            'flex items-center gap-2 rounded px-2 py-1.5 bg-background border border-border select-none cursor-grab active:cursor-grabbing transition-all',
            overIndex === i && dragIndex.current !== i && 'border-primary bg-accent'
          )}
        >
          <GripVertical className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
          <span className="text-[13px] text-foreground">{labels[item]}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface SidebarProps {
  contacts: Contact[];
  channels: Channel[];
  activeConversation: Conversation | null;
  onSelectConversation: (conversation: Conversation) => void;
  onNewMessage: (event?: React.MouseEvent<HTMLButtonElement>) => void;
  lastMessageTimes: ConversationTimes;
  unreadCounts: Record<string, number>;
  mentions: Record<string, boolean>;
  showCracker: boolean;
  crackerRunning: boolean;
  onToggleCracker: () => void;
  onMarkAllRead: () => void;
  isConversationNotificationsEnabled?: (type: 'channel' | 'contact', id: string) => boolean;
  blockedKeys?: string[];
  blockedNames?: string[];
  onOpenChannelImportExport?: () => void;
}

function loadInitialSectionSortOrders(): SidebarSectionSortOrders {
  const storedOrders = loadLocalStorageSidebarSectionSortOrders();
  if (storedOrders) return storedOrders;

  const legacyOrder = loadLegacyLocalStorageSortOrder();
  const orders = buildSidebarSectionSortOrders(legacyOrder ?? undefined);
  saveLocalStorageSidebarSectionSortOrders(orders);
  return orders;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Sidebar({
  contacts,
  channels,
  activeConversation,
  onSelectConversation,
  onNewMessage,
  lastMessageTimes,
  unreadCounts,
  mentions,
  showCracker,
  crackerRunning,
  onToggleCracker,
  onMarkAllRead,
  isConversationNotificationsEnabled,
  blockedKeys = [],
  blockedNames = [],
  onOpenChannelImportExport,
}: SidebarProps) {
  const isContactBlocked = useCallback(
    (c: Contact) =>
      blockedKeys.includes(c.public_key.toLowerCase()) ||
      (c.name != null && blockedNames.includes(c.name)),
    [blockedKeys, blockedNames]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sectionOrder, setSectionOrder] = useState<SidebarSection[]>(loadSectionOrder);
  const [toolOrder, setToolOrder] = useState<ToolKey[]>(loadToolOrder);

  const initialSectionSortOrders = useMemo(loadInitialSectionSortOrders, []);
  const [sectionSortOrders, setSectionSortOrders] = useState(initialSectionSortOrders);
  const initialCollapsedState = useMemo(loadCollapsedState, []);
  const [toolsCollapsed, setToolsCollapsed] = useState(initialCollapsedState.tools);
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(initialCollapsedState.favorites);
  const [channelsCollapsed, setChannelsCollapsed] = useState(initialCollapsedState.channels);
  const [contactsCollapsed, setContactsCollapsed] = useState(initialCollapsedState.contacts);
  const [roomsCollapsed, setRoomsCollapsed] = useState(initialCollapsedState.rooms);
  const [repeatersCollapsed, setRepeatersCollapsed] = useState(initialCollapsedState.repeaters);
  const [favChannelsCollapsed, setFavChannelsCollapsed] = useState(
    initialCollapsedState.favChannels
  );
  const [favContactsCollapsed, setFavContactsCollapsed] = useState(
    initialCollapsedState.favContacts
  );
  const [favRoomsCollapsed, setFavRoomsCollapsed] = useState(initialCollapsedState.favRooms);
  const [favRepeatersCollapsed, setFavRepeatersCollapsed] = useState(
    initialCollapsedState.favRepeaters
  );
  const [ownedCollapsed, setOwnedCollapsed] = useState(initialCollapsedState.owned);
  const [ownedRepeatersCollapsed, setOwnedRepeatersCollapsed] = useState(
    initialCollapsedState.ownedRepeaters
  );
  const [ownedRoomsCollapsed, setOwnedRoomsCollapsed] = useState(initialCollapsedState.ownedRooms);
  const [ownedSensorsCollapsed, setOwnedSensorsCollapsed] = useState(
    initialCollapsedState.ownedSensors
  );
  const listRef = useRef<HTMLDivElement>(null);
  const collapseSnapshotRef = useRef<CollapseState | null>(null);
  const [meshHealthStatus, setMeshHealthStatus] = useState<'ok' | 'medium' | 'high' | null>(null);

  useEffect(() => {
    const fetchMeshHealth = () => {
      const now = Math.floor(Date.now() / 1000);
      fetch(`/api/packets/mesh-health?start_ts=${now - 3600}&end_ts=${now}`)
        .then((r) => r.json())
        .then((data: { high_alert_count: number; medium_alert_count: number }) => {
          if (data.high_alert_count > 0) setMeshHealthStatus('high');
          else if (data.medium_alert_count > 0) setMeshHealthStatus('medium');
          else setMeshHealthStatus('ok');
        })
        .catch(() => setMeshHealthStatus(null));
    };
    fetchMeshHealth();
    const id = setInterval(fetchMeshHealth, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const handleSortToggle = (section: SidebarSortableSection) => {
    setSectionSortOrders((prev) => {
      const nextOrder = prev[section] === 'alpha' ? 'recent' : 'alpha';
      const updated = { ...prev, [section]: nextOrder };
      saveLocalStorageSidebarSectionSortOrders(updated);
      return updated;
    });
  };

  const handleSelectConversation = (conversation: Conversation) => {
    setSearchQuery('');
    onSelectConversation(conversation);
  };

  const isActive = (
    type:
      | 'contact'
      | 'channel'
      | 'raw'
      | 'map'
      | 'visualizer'
      | 'search'
      | 'node'
      | 'mesh-health'
      | 'kms'
      | 'trace'
      | 'bot-detector',
    id: string
  ) => activeConversation?.type === type && activeConversation?.id === id;

  const getUnreadCount = (type: 'channel' | 'contact', id: string): number =>
    unreadCounts[getStateKey(type, id)] || 0;

  const hasMention = (type: 'channel' | 'contact', id: string): boolean =>
    mentions[getStateKey(type, id)] || false;

  const getLastMessageTime = useCallback(
    (type: 'channel' | 'contact', id: string) => lastMessageTimes[getStateKey(type, id)] || 0,
    [lastMessageTimes]
  );

  const getContactHeardTime = useCallback(
    (contact: Contact): number => Math.max(contact.last_seen ?? 0, contact.last_advert ?? 0),
    []
  );

  const getContactRecentTime = useCallback(
    (contact: Contact): number => {
      if (contact.type === CONTACT_TYPE_REPEATER) return getContactHeardTime(contact);
      return getLastMessageTime('contact', contact.public_key) || getContactHeardTime(contact);
    },
    [getContactHeardTime, getLastMessageTime]
  );

  const uniqueChannels = useMemo(
    () =>
      channels.reduce<Channel[]>(
        (acc, c) => (!acc.some((x) => x.key === c.key) ? [...acc, c] : acc),
        []
      ),
    [channels]
  );

  const uniqueContacts = useMemo(
    () =>
      contacts
        .filter((c) => c.public_key && c.public_key.length > 0)
        .sort((a, b) => {
          if (a.name && !b.name) return -1;
          if (!a.name && b.name) return 1;
          return (a.name || '').localeCompare(b.name || '');
        })
        .reduce<Contact[]>(
          (acc, c) => (!acc.some((x) => x.public_key === c.public_key) ? [...acc, c] : acc),
          []
        ),
    [contacts]
  );

  const sortedChannels = useMemo(
    () =>
      [...uniqueChannels].sort((a, b) => {
        if (isPublicChannelKey(a.key)) return -1;
        if (isPublicChannelKey(b.key)) return 1;
        if (sectionSortOrders.channels === 'recent') {
          const tA = getLastMessageTime('channel', a.key);
          const tB = getLastMessageTime('channel', b.key);
          if (tA && tB) return tB - tA;
          if (tA) return -1;
          if (tB) return 1;
        }
        return a.name.localeCompare(b.name);
      }),
    [uniqueChannels, sectionSortOrders.channels, getLastMessageTime]
  );

  const sortContactsByOrder = useCallback(
    (items: Contact[], order: SortOrder) =>
      [...items].sort((a, b) => {
        if (order === 'recent') {
          const tA = getContactRecentTime(a);
          const tB = getContactRecentTime(b);
          if (tA && tB) return tB - tA;
          if (tA) return -1;
          if (tB) return 1;
        }
        return (a.name || a.public_key).localeCompare(b.name || b.public_key);
      }),
    [getContactRecentTime]
  );

  const sortRepeatersByOrder = useCallback(
    (items: Contact[], order: SortOrder) =>
      [...items].sort((a, b) => {
        if (order === 'recent') {
          const tA = getContactHeardTime(a);
          const tB = getContactHeardTime(b);
          if (tA && tB) return tB - tA;
          if (tA) return -1;
          if (tB) return 1;
        }
        return (a.name || a.public_key).localeCompare(b.name || b.public_key);
      }),
    [getContactHeardTime]
  );

  const getFavoriteItemName = useCallback(
    (item: FavoriteItem) =>
      item.type === 'channel'
        ? item.channel.name
        : getContactDisplayName(
            item.contact.name,
            item.contact.public_key,
            item.contact.last_advert
          ),
    []
  );

  const sortFavoriteItemsByOrder = useCallback(
    (items: FavoriteItem[], order: SortOrder) =>
      [...items].sort((a, b) => {
        if (order === 'recent') {
          const tA =
            a.type === 'channel'
              ? getLastMessageTime('channel', a.channel.key)
              : getContactRecentTime(a.contact);
          const tB =
            b.type === 'channel'
              ? getLastMessageTime('channel', b.channel.key)
              : getContactRecentTime(b.contact);
          if (tA && tB) return tB - tA;
          if (tA) return -1;
          if (tB) return 1;
        }
        return getFavoriteItemName(a).localeCompare(getFavoriteItemName(b));
      }),
    [getContactRecentTime, getFavoriteItemName, getLastMessageTime]
  );

  const sortedNonRepeaterContacts = useMemo(
    () =>
      sortContactsByOrder(
        uniqueContacts.filter(
          (c) => c.type !== CONTACT_TYPE_REPEATER && c.type !== CONTACT_TYPE_ROOM
        ),
        sectionSortOrders.contacts
      ),
    [uniqueContacts, sectionSortOrders.contacts, sortContactsByOrder]
  );

  const sortedRooms = useMemo(
    () =>
      sortContactsByOrder(
        uniqueContacts.filter((c) => c.type === CONTACT_TYPE_ROOM),
        sectionSortOrders.rooms
      ),
    [uniqueContacts, sectionSortOrders.rooms, sortContactsByOrder]
  );

  const sortedRepeaters = useMemo(
    () =>
      sortRepeatersByOrder(
        uniqueContacts.filter((c) => c.type === CONTACT_TYPE_REPEATER),
        sectionSortOrders.repeaters
      ),
    [uniqueContacts, sectionSortOrders.repeaters, sortRepeatersByOrder]
  );

  const query = searchQuery.toLowerCase().trim();
  const isSearching = query.length > 0;

  const filteredChannels = useMemo(
    () =>
      query
        ? sortedChannels.filter(
            (c) => c.name.toLowerCase().includes(query) || c.key.toLowerCase().includes(query)
          )
        : sortedChannels,
    [sortedChannels, query]
  );

  const filteredNonRepeaterContacts = useMemo(() => {
    const visible = sortedNonRepeaterContacts.filter((c) => !isContactBlocked(c));
    return query
      ? visible.filter(
          (c) => c.name?.toLowerCase().includes(query) || c.public_key.toLowerCase().includes(query)
        )
      : visible;
  }, [sortedNonRepeaterContacts, query, isContactBlocked]);

  const filteredRooms = useMemo(() => {
    const visible = sortedRooms.filter((c) => !isContactBlocked(c));
    return query
      ? visible.filter(
          (c) => c.name?.toLowerCase().includes(query) || c.public_key.toLowerCase().includes(query)
        )
      : visible;
  }, [sortedRooms, query, isContactBlocked]);

  const filteredRepeaters = useMemo(() => {
    const visible = sortedRepeaters.filter((c) => !isContactBlocked(c));
    return query
      ? visible.filter(
          (c) => c.name?.toLowerCase().includes(query) || c.public_key.toLowerCase().includes(query)
        )
      : visible;
  }, [sortedRepeaters, query, isContactBlocked]);

  // Persist collapse state
  useEffect(() => {
    localStorage.setItem(
      SIDEBAR_COLLAPSE_STATE_KEY,
      JSON.stringify({
        tools: toolsCollapsed,
        favorites: favoritesCollapsed,
        owned: ownedCollapsed,
        channels: channelsCollapsed,
        contacts: contactsCollapsed,
        rooms: roomsCollapsed,
        repeaters: repeatersCollapsed,
        favChannels: favChannelsCollapsed,
        favContacts: favContactsCollapsed,
        favRooms: favRoomsCollapsed,
        favRepeaters: favRepeatersCollapsed,
        ownedRepeaters: ownedRepeatersCollapsed,
        ownedRooms: ownedRoomsCollapsed,
        ownedSensors: ownedSensorsCollapsed,
      })
    );
  }, [
    toolsCollapsed,
    favoritesCollapsed,
    ownedCollapsed,
    channelsCollapsed,
    contactsCollapsed,
    roomsCollapsed,
    repeatersCollapsed,
    favChannelsCollapsed,
    favContactsCollapsed,
    favRoomsCollapsed,
    favRepeatersCollapsed,
    ownedRepeatersCollapsed,
    ownedRoomsCollapsed,
    ownedSensorsCollapsed,
  ]);

  // Expand all while searching, restore on clear
  useEffect(() => {
    if (isSearching) {
      if (!collapseSnapshotRef.current) {
        collapseSnapshotRef.current = {
          tools: toolsCollapsed,
          favorites: favoritesCollapsed,
          owned: ownedCollapsed,
          channels: channelsCollapsed,
          contacts: contactsCollapsed,
          rooms: roomsCollapsed,
          repeaters: repeatersCollapsed,
          favChannels: favChannelsCollapsed,
          favContacts: favContactsCollapsed,
          favRooms: favRoomsCollapsed,
          favRepeaters: favRepeatersCollapsed,
          ownedRepeaters: ownedRepeatersCollapsed,
          ownedRooms: ownedRoomsCollapsed,
          ownedSensors: ownedSensorsCollapsed,
        };
      }
      const anyCollapsed =
        toolsCollapsed ||
        favoritesCollapsed ||
        ownedCollapsed ||
        channelsCollapsed ||
        contactsCollapsed ||
        roomsCollapsed ||
        repeatersCollapsed ||
        favChannelsCollapsed ||
        favContactsCollapsed ||
        favRoomsCollapsed ||
        favRepeatersCollapsed ||
        ownedRepeatersCollapsed ||
        ownedRoomsCollapsed ||
        ownedSensorsCollapsed;
      if (anyCollapsed) {
        setToolsCollapsed(false);
        setFavoritesCollapsed(false);
        setOwnedCollapsed(false);
        setChannelsCollapsed(false);
        setContactsCollapsed(false);
        setRoomsCollapsed(false);
        setRepeatersCollapsed(false);
        setFavChannelsCollapsed(false);
        setFavContactsCollapsed(false);
        setFavRoomsCollapsed(false);
        setFavRepeatersCollapsed(false);
        setOwnedRepeatersCollapsed(false);
        setOwnedRoomsCollapsed(false);
        setOwnedSensorsCollapsed(false);
      }
      return;
    }
    if (collapseSnapshotRef.current) {
      const prev = collapseSnapshotRef.current;
      collapseSnapshotRef.current = null;
      setToolsCollapsed(prev.tools);
      setFavoritesCollapsed(prev.favorites);
      setOwnedCollapsed(prev.owned);
      setChannelsCollapsed(prev.channels);
      setContactsCollapsed(prev.contacts);
      setRoomsCollapsed(prev.rooms);
      setRepeatersCollapsed(prev.repeaters);
      setFavChannelsCollapsed(prev.favChannels);
      setFavContactsCollapsed(prev.favContacts);
      setFavRoomsCollapsed(prev.favRooms);
      setFavRepeatersCollapsed(prev.favRepeaters);
      setOwnedRepeatersCollapsed(prev.ownedRepeaters);
      setOwnedRoomsCollapsed(prev.ownedRooms);
      setOwnedSensorsCollapsed(prev.ownedSensors);
    }
  }, [
    isSearching,
    toolsCollapsed,
    favoritesCollapsed,
    ownedCollapsed,
    channelsCollapsed,
    contactsCollapsed,
    roomsCollapsed,
    repeatersCollapsed,
    favChannelsCollapsed,
    favContactsCollapsed,
    favRoomsCollapsed,
    favRepeatersCollapsed,
    ownedRepeatersCollapsed,
    ownedRoomsCollapsed,
    ownedSensorsCollapsed,
  ]);

  const {
    favoriteItems,
    nonFavoriteChannels,
    nonFavoriteContacts,
    nonFavoriteRooms,
    nonFavoriteRepeaters,
    ownedRepeaters,
    ownedRooms,
    ownedSensors,
  } = useMemo(() => {
    const favChannels = filteredChannels.filter((c) => c.favorite);
    const favContacts = [
      ...filteredNonRepeaterContacts,
      ...filteredRooms,
      ...filteredRepeaters,
    ].filter((c) => c.favorite);
    const nonFavChannels = filteredChannels.filter((c) => !c.favorite);
    const nonFavContacts = filteredNonRepeaterContacts.filter((c) => !c.favorite);
    const nonFavRooms = filteredRooms.filter((c) => !c.favorite);
    const nonFavRepeaters = filteredRepeaters.filter((c) => !c.favorite);

    const items: FavoriteItem[] = [
      ...favChannels.map((channel) => ({ type: 'channel' as const, channel })),
      ...favContacts.map((contact) => ({ type: 'contact' as const, contact })),
    ];
    // Owned: nodes with owner_id set — search ALL contacts (including favourites)
    const ownedReps = filteredRepeaters.filter((c) => c.owner_id);
    const ownedRms = filteredRooms.filter((c) => c.owner_id);
    const ownedSnsr = filteredNonRepeaterContacts.filter(
      (c) => c.type === CONTACT_TYPE_SENSOR && c.owner_id
    );
    return {
      favoriteItems: sortFavoriteItemsByOrder(items, sectionSortOrders.favorites),
      nonFavoriteChannels: nonFavChannels,
      // Exclude owned items from their regular sections
      nonFavoriteContacts: nonFavContacts.filter(
        (c) => !(c.type === CONTACT_TYPE_SENSOR && c.owner_id)
      ),
      nonFavoriteRooms: nonFavRooms.filter((c) => !c.owner_id),
      nonFavoriteRepeaters: nonFavRepeaters.filter((c) => !c.owner_id),
      ownedRepeaters: ownedReps,
      ownedRooms: ownedRms,
      ownedSensors: ownedSnsr,
    };
  }, [
    filteredChannels,
    filteredNonRepeaterContacts,
    filteredRooms,
    filteredRepeaters,
    sectionSortOrders.favorites,
    sortFavoriteItemsByOrder,
  ]);

  const buildChannelRow = (channel: Channel, keyPrefix: string): ConversationRow => ({
    key: `${keyPrefix}-${channel.key}`,
    type: 'channel',
    id: channel.key,
    name: channel.name,
    unreadCount: getUnreadCount('channel', channel.key),
    isMention: hasMention('channel', channel.key),
    notificationsEnabled: isConversationNotificationsEnabled?.('channel', channel.key) ?? false,
  });

  const buildContactRow = (contact: Contact, keyPrefix: string): ConversationRow => ({
    key: `${keyPrefix}-${contact.public_key}`,
    type: 'contact',
    id: contact.public_key,
    name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
    unreadCount: getUnreadCount('contact', contact.public_key),
    isMention: hasMention('contact', contact.public_key),
    notificationsEnabled:
      isConversationNotificationsEnabled?.('contact', contact.public_key) ?? false,
    contact,
  });

  const renderConversationRow = (row: ConversationRow) => {
    const highlightUnread =
      row.isMention ||
      (row.type === 'contact' &&
        row.contact?.type !== CONTACT_TYPE_REPEATER &&
        row.unreadCount > 0);

    return (
      <div
        key={row.key}
        className={cn(
          'px-3 py-2 cursor-pointer flex items-center gap-2 border-l-2 border-transparent hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isActive(row.type, row.id) && 'bg-accent border-l-primary',
          row.unreadCount > 0 && '[&_.name]:font-semibold [&_.name]:text-foreground'
        )}
        role="button"
        tabIndex={0}
        aria-current={isActive(row.type, row.id) ? 'page' : undefined}
        onKeyDown={handleKeyboardActivate}
        onClick={() => handleSelectConversation({ type: row.type, id: row.id, name: row.name })}
      >
        {row.type === 'contact' && row.contact && (
          <ContactAvatar
            name={row.contact.name}
            publicKey={row.contact.public_key}
            size={24}
            contactType={row.contact.type}
          />
        )}
        <span className="name flex-1 truncate text-[0.8125rem]">{row.name}</span>
        <span className="ml-auto flex items-center gap-1">
          {row.notificationsEnabled && (
            <span aria-label="Notifications enabled" title="Notifications enabled">
              <Bell className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          )}
          {row.unreadCount > 0 && (
            <span
              className={cn(
                'text-[0.625rem] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center',
                highlightUnread
                  ? 'bg-badge-mention text-badge-mention-foreground'
                  : 'bg-badge-unread/90 text-badge-unread-foreground'
              )}
              aria-label={`${row.unreadCount} unread message${row.unreadCount !== 1 ? 's' : ''}`}
            >
              {row.unreadCount}
            </span>
          )}
        </span>
      </div>
    );
  };

  const renderSidebarActionRow = ({
    key,
    active = false,
    icon,
    label,
    onClick,
  }: {
    key: string;
    active?: boolean;
    icon: React.ReactNode;
    label: React.ReactNode;
    onClick: () => void;
  }) => (
    <div
      key={key}
      data-active={active ? 'true' : undefined}
      className={cn(
        'sidebar-action-row px-3 py-2 cursor-pointer flex items-center gap-2 border-l-2 border-transparent hover:bg-accent transition-colors text-[0.8125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-accent border-l-primary'
      )}
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      onKeyDown={handleKeyboardActivate}
      onClick={onClick}
    >
      <span className="sidebar-tool-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sidebar-tool-label flex-1 truncate">{label}</span>
    </div>
  );

  const getSectionUnreadCount = (rows: ConversationRow[]): number =>
    rows.reduce((total, row) => total + row.unreadCount, 0);

  const sectionHasMention = (rows: ConversationRow[]): boolean => rows.some((row) => row.isMention);

  const favoriteRows = favoriteItems.map((item) =>
    item.type === 'channel'
      ? buildChannelRow(item.channel, 'fav-chan')
      : buildContactRow(item.contact, 'fav-contact')
  );

  const favChannelRows = favoriteItems
    .filter((item): item is { type: 'channel'; channel: Channel } => item.type === 'channel')
    .map((item) => buildChannelRow(item.channel, 'fav-chan'));

  const favContactRows = favoriteItems
    .filter(
      (item): item is { type: 'contact'; contact: Contact } =>
        item.type === 'contact' &&
        item.contact.type !== CONTACT_TYPE_REPEATER &&
        item.contact.type !== CONTACT_TYPE_ROOM
    )
    .map((item) => buildContactRow(item.contact, 'fav-contact'));

  const favRoomRows = favoriteItems
    .filter(
      (item): item is { type: 'contact'; contact: Contact } =>
        item.type === 'contact' && item.contact.type === CONTACT_TYPE_ROOM
    )
    .map((item) => buildContactRow(item.contact, 'fav-room'));

  const favRepeaterRows = favoriteItems
    .filter(
      (item): item is { type: 'contact'; contact: Contact } =>
        item.type === 'contact' && item.contact.type === CONTACT_TYPE_REPEATER
    )
    .map((item) => buildContactRow(item.contact, 'fav-repeater'));

  const channelRows = nonFavoriteChannels.map((channel) => buildChannelRow(channel, 'chan'));
  const contactRows = nonFavoriteContacts.map((contact) => buildContactRow(contact, 'contact'));
  const roomRows = nonFavoriteRooms.map((contact) => buildContactRow(contact, 'room'));
  const repeaterRows = nonFavoriteRepeaters.map((contact) => buildContactRow(contact, 'repeater'));
  const ownedRepeaterRows = ownedRepeaters.map((c) => buildContactRow(c, 'owned-rep'));
  const ownedRoomRows = ownedRooms.map((c) => buildContactRow(c, 'owned-room'));
  const ownedSensorRows = ownedSensors.map((c) => buildContactRow(c, 'owned-sensor'));

  const favoritesUnreadCount = getSectionUnreadCount(favoriteRows);
  const channelsUnreadCount = getSectionUnreadCount(channelRows);
  const contactsUnreadCount = getSectionUnreadCount(contactRows);
  const roomsUnreadCount = getSectionUnreadCount(roomRows);
  const repeatersUnreadCount = getSectionUnreadCount(repeaterRows);
  const ownedUnreadCount = getSectionUnreadCount([
    ...ownedRepeaterRows,
    ...ownedRoomRows,
    ...ownedSensorRows,
  ]);
  const favoritesHasMention = sectionHasMention(favoriteRows);
  const channelsHasMention = sectionHasMention(channelRows);
  const toolRows = !query
    ? [
        renderSidebarActionRow({
          key: 'tool-raw',
          active: isActive('raw', 'raw'),
          icon: <Logs className="h-4 w-4" />,
          label: 'Packet Feed',
          onClick: () =>
            handleSelectConversation({ type: 'raw', id: 'raw', name: 'Raw Packet Feed' }),
        }),
        renderSidebarActionRow({
          key: 'tool-map',
          active: isActive('map', 'map'),
          icon: <Map className="h-4 w-4" />,
          label: 'Node Map',
          onClick: () => handleSelectConversation({ type: 'map', id: 'map', name: 'Node Map' }),
        }),
        renderSidebarActionRow({
          key: 'tool-visualizer',
          active: isActive('visualizer', 'visualizer'),
          icon: <ChartNetwork className="h-4 w-4" />,
          label: 'Mesh Visualizer',
          onClick: () =>
            handleSelectConversation({
              type: 'visualizer',
              id: 'visualizer',
              name: 'Mesh Visualizer',
            }),
        }),
        renderSidebarActionRow({
          key: 'tool-trace',
          active: isActive('trace', 'trace'),
          icon: <Cable className="h-4 w-4" />,
          label: 'Trace',
          onClick: () => handleSelectConversation({ type: 'trace', id: 'trace', name: 'Trace' }),
        }),
        renderSidebarActionRow({
          key: 'tool-search',
          active: isActive('search', 'search'),
          icon: <SearchIcon className="h-4 w-4" />,
          label: 'Message Search',
          onClick: () =>
            handleSelectConversation({ type: 'search', id: 'search', name: 'Message Search' }),
        }),
        renderSidebarActionRow({
          key: 'tool-node',
          active: isActive('node', 'node'),
          icon: <BarChart2 className="h-4 w-4" />,
          label: 'My Node',
          onClick: () => handleSelectConversation({ type: 'node', id: 'node', name: 'My Node' }),
        }),
        renderSidebarActionRow({
          key: 'tool-mesh-health',
          active: isActive('mesh-health', 'mesh-health'),
          icon: <Activity className="h-4 w-4" />,
          label: (
            <span className="flex items-center justify-between w-full">
              <span>Mesh Health</span>
              {meshHealthStatus === 'ok' && (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
              )}
              {meshHealthStatus === 'medium' && (
                <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 flex-shrink-0" />
              )}
              {meshHealthStatus === 'high' && (
                <AlertCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
              )}
            </span>
          ),
          onClick: () =>
            handleSelectConversation({
              type: 'mesh-health',
              id: 'mesh-health',
              name: 'Mesh Health',
            }),
        }),
        renderSidebarActionRow({
          key: 'tool-cracker',
          active: showCracker,
          icon: <LockOpen className="h-4 w-4" />,
          label: (
            <>
              {showCracker ? 'Hide' : 'Show'} Channel Finder
              <span
                className={cn(
                  'ml-1 text-[0.6875rem]',
                  crackerRunning ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                ({crackerRunning ? 'running' : 'idle'})
              </span>
            </>
          ),
          onClick: onToggleCracker,
        }),
        renderSidebarActionRow({
          key: 'tool-mc-kms',
          active: isActive('kms', 'kms'),
          icon: <KeyRound className="h-4 w-4" />,
          label: 'MC-KMS',
          onClick: () => handleSelectConversation({ type: 'kms', id: 'kms', name: 'MC-KMS' }),
        }),
        renderSidebarActionRow({
          key: 'tool-bot-detector',
          active: isActive('bot-detector', 'bot-detector'),
          icon: <Bot className="h-4 w-4" />,
          label: 'Bot Detector',
          onClick: () =>
            handleSelectConversation({
              type: 'bot-detector',
              id: 'bot-detector',
              name: 'Bot Detector',
            }),
        }),
      ]
    : [];

  const renderSectionHeader = (
    title: string,
    collapsed: boolean,
    onToggle: () => void,
    sortSection: SidebarSortableSection | null = null,
    unreadCount = 0,
    highlightUnread = false,
    onMarkRead?: () => void,
    itemCount?: number
  ) => {
    const effectiveCollapsed = isSearching ? false : collapsed;
    const sectionSortOrder = sortSection ? sectionSortOrders[sortSection] : null;

    return (
      <div className="flex justify-between items-center px-3 py-2 pt-3.5">
        <button
          className={cn(
            'flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded',
            isSearching && 'cursor-default'
          )}
          aria-expanded={!effectiveCollapsed}
          onClick={() => {
            if (!isSearching) onToggle();
          }}
          title={effectiveCollapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          {effectiveCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>
            {title}
            {itemCount !== undefined && itemCount > 0 ? ` (${itemCount})` : ''}
          </span>
        </button>
        {(sortSection || unreadCount > 0) && (
          <div className="ml-auto flex items-center gap-1.5">
            {sortSection && sectionSortOrder && (
              <button
                className="bg-transparent text-muted-foreground/60 px-1 py-0.5 text-[0.625rem] rounded hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => handleSortToggle(sortSection)}
                aria-label={
                  sectionSortOrder === 'alpha'
                    ? `Sort ${title} by recent`
                    : `Sort ${title} alphabetically`
                }
                title={
                  sectionSortOrder === 'alpha'
                    ? `Sort ${title} by recent`
                    : `Sort ${title} alphabetically`
                }
              >
                {sectionSortOrder === 'alpha' ? 'A-Z' : '⏱'}
              </button>
            )}
            {onMarkRead && unreadCount > 0 && (
              <button
                className="text-muted-foreground/60 hover:text-foreground transition-colors rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onMarkRead}
                title="Mark all as read"
                aria-label="Mark all as read"
              >
                <CheckCheck className="h-3.5 w-3.5" />
              </button>
            )}
            {unreadCount > 0 && (
              <span
                className={cn(
                  'text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full',
                  highlightUnread
                    ? 'bg-badge-mention text-badge-mention-foreground'
                    : 'bg-secondary text-muted-foreground'
                )}
                aria-label={`${unreadCount} unread`}
              >
                {unreadCount}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Section renderer ────────────────────────────────────────────────────────

  const renderSection = (section: SidebarSection) => {
    switch (section) {
      case 'tools':
        return toolRows.length > 0 ? (
          <div key="tools">
            {renderSectionHeader('Tools', toolsCollapsed, () => setToolsCollapsed((p) => !p))}
            {(isSearching || !toolsCollapsed) && toolRows}
          </div>
        ) : null;
      case 'favorites':
        return favoriteItems.length > 0 ? (
          <div key="favorites">
            {renderSectionHeader(
              'Favorites',
              favoritesCollapsed,
              () => setFavoritesCollapsed((p) => !p),
              'favorites',
              favoritesUnreadCount,
              favoritesHasMention,
              undefined,
              favoriteItems.length
            )}
            {(isSearching || !favoritesCollapsed) && (
              <>
                {favChannelRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setFavChannelsCollapsed((p) => !p)}
                      aria-expanded={!favChannelsCollapsed}
                    >
                      {favChannelsCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Channels
                    </button>
                    {(isSearching || !favChannelsCollapsed) &&
                      favChannelRows.map((row) => renderConversationRow(row))}
                  </>
                )}
                {favContactRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setFavContactsCollapsed((p) => !p)}
                      aria-expanded={!favContactsCollapsed}
                    >
                      {favContactsCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Contacts
                    </button>
                    {(isSearching || !favContactsCollapsed) &&
                      favContactRows.map((row) => renderConversationRow(row))}
                  </>
                )}
                {favRoomRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setFavRoomsCollapsed((p) => !p)}
                      aria-expanded={!favRoomsCollapsed}
                    >
                      {favRoomsCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Room Servers
                    </button>
                    {(isSearching || !favRoomsCollapsed) &&
                      favRoomRows.map((row) => renderConversationRow(row))}
                  </>
                )}
                {favRepeaterRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setFavRepeatersCollapsed((p) => !p)}
                      aria-expanded={!favRepeatersCollapsed}
                    >
                      {favRepeatersCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Repeaters
                    </button>
                    {(isSearching || !favRepeatersCollapsed) &&
                      favRepeaterRows.map((row) => renderConversationRow(row))}
                  </>
                )}
              </>
            )}
          </div>
        ) : null;
      case 'owned': {
        const totalOwned = ownedRepeaters.length + ownedRooms.length + ownedSensors.length;
        return totalOwned > 0 ? (
          <div key="owned">
            {renderSectionHeader(
              'Owned',
              ownedCollapsed,
              () => setOwnedCollapsed((p) => !p),
              null,
              ownedUnreadCount,
              false,
              undefined,
              totalOwned
            )}
            {(isSearching || !ownedCollapsed) && (
              <>
                {ownedRepeaterRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setOwnedRepeatersCollapsed((p) => !p)}
                      aria-expanded={!ownedRepeatersCollapsed}
                    >
                      {ownedRepeatersCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Repeaters
                    </button>
                    {(isSearching || !ownedRepeatersCollapsed) &&
                      ownedRepeaterRows.map((row) => renderConversationRow(row))}
                  </>
                )}
                {ownedRoomRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setOwnedRoomsCollapsed((p) => !p)}
                      aria-expanded={!ownedRoomsCollapsed}
                    >
                      {ownedRoomsCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Room Servers
                    </button>
                    {(isSearching || !ownedRoomsCollapsed) &&
                      ownedRoomRows.map((row) => renderConversationRow(row))}
                  </>
                )}
                {ownedSensorRows.length > 0 && (
                  <>
                    <button
                      className="w-full flex items-center gap-1 px-4 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold hover:text-muted-foreground transition-colors focus-visible:outline-none"
                      onClick={() => setOwnedSensorsCollapsed((p) => !p)}
                      aria-expanded={!ownedSensorsCollapsed}
                    >
                      {ownedSensorsCollapsed ? (
                        <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
                      )}
                      Sensors
                    </button>
                    {(isSearching || !ownedSensorsCollapsed) &&
                      ownedSensorRows.map((row) => renderConversationRow(row))}
                  </>
                )}
              </>
            )}
          </div>
        ) : null;
      }
      case 'channels':
        return nonFavoriteChannels.length > 0 ? (
          <div key="channels">
            <div className="flex items-center">
              <div className="flex-1 min-w-0">
                {renderSectionHeader(
                  'Channels',
                  channelsCollapsed,
                  () => setChannelsCollapsed((p) => !p),
                  'channels',
                  channelsUnreadCount,
                  channelsHasMention,
                  onMarkAllRead,
                  filteredChannels.length
                )}
              </div>
              {onOpenChannelImportExport && (
                <button
                  onClick={onOpenChannelImportExport}
                  className="mr-3 text-muted-foreground/60 hover:text-foreground transition-colors rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex-shrink-0"
                  title="Import / Export channels"
                  aria-label="Import or export channels"
                >
                  <ArrowDownUp className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {(isSearching || !channelsCollapsed) &&
              channelRows.map((row) => renderConversationRow(row))}
          </div>
        ) : null;
      case 'contacts':
        return nonFavoriteContacts.length > 0 ? (
          <div key="contacts">
            {renderSectionHeader(
              'Contacts',
              contactsCollapsed,
              () => setContactsCollapsed((p) => !p),
              'contacts',
              contactsUnreadCount,
              contactsUnreadCount > 0,
              undefined,
              filteredNonRepeaterContacts.length
            )}
            {(isSearching || !contactsCollapsed) &&
              contactRows.map((row) => renderConversationRow(row))}
          </div>
        ) : null;
      case 'rooms':
        return nonFavoriteRooms.length > 0 ? (
          <div key="rooms">
            {renderSectionHeader(
              'Room Servers',
              roomsCollapsed,
              () => setRoomsCollapsed((p) => !p),
              'rooms',
              roomsUnreadCount,
              roomsUnreadCount > 0,
              undefined,
              filteredRooms.length
            )}
            {(isSearching || !roomsCollapsed) && roomRows.map((row) => renderConversationRow(row))}
          </div>
        ) : null;
      case 'repeaters':
        return nonFavoriteRepeaters.length > 0 ? (
          <div key="repeaters">
            {renderSectionHeader(
              'Repeaters',
              repeatersCollapsed,
              () => setRepeatersCollapsed((p) => !p),
              'repeaters',
              repeatersUnreadCount,
              false,
              undefined,
              filteredRepeaters.length
            )}
            {(isSearching || !repeatersCollapsed) &&
              repeaterRows.map((row) => renderConversationRow(row))}
          </div>
        ) : null;
      default:
        return null;
    }
  };

  const isEmpty =
    nonFavoriteContacts.length === 0 &&
    nonFavoriteRooms.length === 0 &&
    nonFavoriteChannels.length === 0 &&
    nonFavoriteRepeaters.length === 0 &&
    favoriteItems.length === 0 &&
    ownedRepeaters.length === 0 &&
    ownedRooms.length === 0 &&
    ownedSensors.length === 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <nav
      className="sidebar w-60 h-full min-h-0 overflow-hidden bg-card border-r border-border flex flex-col"
      aria-label="Conversations"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={onNewMessage}
          title="Add channel or contact"
          aria-label="Add channel or contact"
          className="h-8 flex-1 justify-start gap-2 border-primary/20 bg-primary/5 px-3 text-[0.8125rem] text-primary hover:bg-primary/10 hover:text-primary"
        >
          <SquarePen className="h-4 w-4" />
          <span>Add Channel/Contact</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSettings((p) => !p)}
          title={showSettings ? 'Back to conversations' : 'Customize sidebar'}
          aria-label={showSettings ? 'Back to conversations' : 'Customize sidebar'}
          className={cn(
            'h-7 w-7 shrink-0 p-0 transition-colors',
            showSettings
              ? 'text-primary hover:text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>

      {showSettings ? (
        /* Settings panel */
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-5">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Section Order
            </p>
            <DragList
              items={sectionOrder}
              labels={SECTION_LABELS}
              onReorder={(next) => {
                setSectionOrder(next);
                saveSectionOrder(next);
              }}
            />
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Tool Order
            </p>
            <DragList
              items={toolOrder}
              labels={TOOL_LABELS}
              onReorder={(next) => {
                setToolOrder(next);
                saveToolOrder(next);
              }}
            />
          </div>

          <button
            onClick={() => {
              setSectionOrder([...ALL_SECTIONS]);
              setToolOrder([...ALL_TOOL_KEYS]);
              localStorage.removeItem(SIDEBAR_SECTION_ORDER_KEY);
              localStorage.removeItem(SIDEBAR_TOOL_ORDER_KEY);
            }}
            className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            Reset to defaults
          </button>
        </div>
      ) : (
        /* Main list */
        <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
          {/* Search */}
          <div className="px-3 py-2 border-b border-border/60 flex-shrink-0">
            <div className="relative min-w-0">
              <Input
                type="text"
                placeholder="Search channels/contacts..."
                aria-label="Search conversations"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={cn('h-7 text-[13px] bg-background/50', searchQuery ? 'pr-8' : 'pr-3')}
              />
              {searchQuery && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          {/* Scroll to top */}
          <button
            onClick={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            title="Scroll to top"
            aria-label="Scroll to top"
            className="absolute top-1 left-1/2 -translate-x-1/2 z-10 rounded-full bg-card/80 border border-border p-0.5 text-muted-foreground/40 hover:text-foreground hover:opacity-100 transition opacity-40 backdrop-blur-sm pointer-events-auto"
          >
            <ChevronsUp className="h-3.5 w-3.5" />
          </button>
          {/* Scroll to bottom */}
          <button
            onClick={() =>
              listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
            }
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            className="absolute bottom-1 left-1/2 -translate-x-1/2 z-10 rounded-full bg-card/80 border border-border p-0.5 text-muted-foreground/40 hover:text-foreground hover:opacity-100 transition opacity-40 backdrop-blur-sm pointer-events-auto"
          >
            <ChevronsDown className="h-3.5 w-3.5" />
          </button>
          <div ref={listRef} className="flex-1 overflow-y-auto [contain:layout_paint]">
            {sectionOrder.map((section) => renderSection(section))}
            {isEmpty && (
              <div className="p-5 text-center text-muted-foreground">
                {query ? 'No matches found' : 'No conversations yet'}
              </div>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
