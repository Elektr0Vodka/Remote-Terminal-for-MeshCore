import { useState, useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import {
  parseHashConversation,
  updateUrlHash,
  resolveChannelFromHashToken,
  resolveContactFromHashToken,
} from '../utils/urlHash';
import {
  getLastViewedConversation,
  getReopenLastConversationEnabled,
  saveLastViewedConversation,
} from '../utils/lastViewedConversation';
import { getContactDisplayName } from '../utils/pubkey';
import type { Channel, Contact, Conversation } from '../types';

const PUBLIC_CHANNEL_KEY = '8B3387E9C5CDEA6AC9E5EDBAA115CD72';

interface UseConversationRouterArgs {
  channels: Channel[];
  contacts: Contact[];
  contactsLoaded: boolean;
  setSidebarOpen: (open: boolean) => void;
  pendingDeleteFallbackRef: MutableRefObject<boolean>;
  hasSetDefaultConversation: MutableRefObject<boolean>;
}

export function useConversationRouter({
  channels,
  contacts,
  contactsLoaded,
  setSidebarOpen,
  pendingDeleteFallbackRef,
  hasSetDefaultConversation,
}: UseConversationRouterArgs) {
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const activeConversationRef = useRef<Conversation | null>(null);

  const getPublicChannelConversation = useCallback((): Conversation | null => {
    const publicChannel = channels.find((c) => c.name === 'Public');
    if (!publicChannel) return null;
    return {
      type: 'channel',
      id: publicChannel.key,
      name: publicChannel.name,
    };
  }, [channels]);

  // Phase 1: Set initial conversation from URL hash or default to Public channel
  // Only needs channels (fast path) - doesn't wait for contacts
  useEffect(() => {
    if (hasSetDefaultConversation.current || activeConversation) return;
    if (channels.length === 0) return;

    const hashConv = parseHashConversation();

    // Handle non-data views immediately
    if (hashConv?.type === 'raw') {
      setActiveConversation({ type: 'raw', id: 'raw', name: 'Raw Packet Feed' });
      hasSetDefaultConversation.current = true;
      return;
    }
    if (hashConv?.type === 'map') {
      setActiveConversation({
        type: 'map',
        id: 'map',
        name: 'Node Map',
        mapFocusKey: hashConv.mapFocusKey,
      });
      hasSetDefaultConversation.current = true;
      return;
    }
    if (hashConv?.type === 'visualizer') {
      setActiveConversation({ type: 'visualizer', id: 'visualizer', name: 'Mesh Visualizer' });
      hasSetDefaultConversation.current = true;
      return;
    }

    // Handle channel hash (ID-first with legacy-name fallback)
    if (hashConv?.type === 'channel') {
      const channel = resolveChannelFromHashToken(hashConv.name, channels);
      if (channel) {
        setActiveConversation({ type: 'channel', id: channel.key, name: channel.name });
        hasSetDefaultConversation.current = true;
        return;
      }
    }

    // Contact hash — wait for phase 2
    if (hashConv?.type === 'contact') return;

    // No hash: optionally restore last-viewed conversation if enabled on this device.
    if (!hashConv && getReopenLastConversationEnabled()) {
      const lastViewed = getLastViewedConversation();
      if (lastViewed?.type === 'raw') {
        setActiveConversation(lastViewed);
        hasSetDefaultConversation.current = true;
        return;
      }
      if (lastViewed?.type === 'map') {
        setActiveConversation(lastViewed);
        hasSetDefaultConversation.current = true;
        return;
      }
      if (lastViewed?.type === 'visualizer') {
        setActiveConversation(lastViewed);
        hasSetDefaultConversation.current = true;
        return;
      }
      if (lastViewed?.type === 'channel') {
        const channel =
          channels.find((c) => c.key.toLowerCase() === lastViewed.id.toLowerCase()) ||
          resolveChannelFromHashToken(lastViewed.id, channels);
        if (channel) {
          setActiveConversation({
            type: 'channel',
            id: channel.key,
            name: channel.name,
          });
          hasSetDefaultConversation.current = true;
          return;
        }
      }
      // Last-viewed contact resolution waits for contacts in phase 2.
      if (lastViewed?.type === 'contact') return;
    }

    // No hash or unresolvable — default to Public
    const publicConversation = getPublicChannelConversation();
    if (publicConversation) {
      setActiveConversation(publicConversation);
      hasSetDefaultConversation.current = true;
    }
  }, [channels, activeConversation, getPublicChannelConversation]);

  // Phase 2: Resolve contact hash (only if phase 1 didn't set a conversation)
  useEffect(() => {
    if (hasSetDefaultConversation.current || activeConversation) return;

    const hashConv = parseHashConversation();
    if (hashConv?.type === 'contact') {
      if (!contactsLoaded) return;

      const contact = resolveContactFromHashToken(hashConv.name, contacts);
      if (contact) {
        setActiveConversation({
          type: 'contact',
          id: contact.public_key,
          name: getContactDisplayName(contact.name, contact.public_key),
        });
        hasSetDefaultConversation.current = true;
        return;
      }

      // Contact hash didn't match — fall back to Public if channels loaded.
      const publicConversation = getPublicChannelConversation();
      if (publicConversation) {
        setActiveConversation(publicConversation);
        hasSetDefaultConversation.current = true;
      }
      return;
    }

    // No hash: optionally restore a last-viewed contact once contacts are loaded.
    if (!hashConv && getReopenLastConversationEnabled()) {
      const lastViewed = getLastViewedConversation();
      if (lastViewed?.type !== 'contact') return;
      if (!contactsLoaded) return;

      const contact = contacts.find(
        (item) => item.public_key.toLowerCase() === lastViewed.id.toLowerCase()
      );
      if (contact) {
        setActiveConversation({
          type: 'contact',
          id: contact.public_key,
          name: getContactDisplayName(contact.name, contact.public_key),
        });
        hasSetDefaultConversation.current = true;
        return;
      }

      const publicConversation = getPublicChannelConversation();
      if (publicConversation) {
        setActiveConversation(publicConversation);
        hasSetDefaultConversation.current = true;
      }
    }
  }, [contacts, channels, activeConversation, contactsLoaded, getPublicChannelConversation]);

  // Keep ref in sync and update URL hash
  useEffect(() => {
    activeConversationRef.current = activeConversation;
    if (activeConversation) {
      updateUrlHash(activeConversation);
      if (getReopenLastConversationEnabled()) {
        saveLastViewedConversation(activeConversation);
      }
    }
  }, [activeConversation]);

  // If a delete action left us without an active conversation, recover to Public
  useEffect(() => {
    if (!pendingDeleteFallbackRef.current) return;
    if (activeConversation) {
      pendingDeleteFallbackRef.current = false;
      return;
    }

    const publicChannel =
      channels.find((c) => c.key === PUBLIC_CHANNEL_KEY) ||
      channels.find((c) => c.name === 'Public');
    if (!publicChannel) return;

    hasSetDefaultConversation.current = true;
    pendingDeleteFallbackRef.current = false;
    setActiveConversation({
      type: 'channel',
      id: publicChannel.key,
      name: publicChannel.name,
    });
  }, [activeConversation, channels]);

  // Handle conversation selection (closes sidebar on mobile)
  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      setActiveConversation(conv);
      setSidebarOpen(false);
    },
    [setSidebarOpen]
  );

  return {
    activeConversation,
    setActiveConversation,
    activeConversationRef,
    handleSelectConversation,
  };
}
