import type React from 'react';
import { toast } from './ui/sonner';
import { formatTime } from '../utils/messageParser';
import { isValidLocation, calculateDistance, formatDistance } from '../utils/pathUtils';
import { getMapFocusHash } from '../utils/urlHash';
import { isFavorite } from '../utils/favorites';
import type { Contact, Conversation, Favorite, RadioConfig } from '../types';

interface ChatHeaderProps {
  conversation: Conversation;
  contacts: Contact[];
  config: RadioConfig | null;
  favorites: Favorite[];
  onTrace: () => void;
  onToggleFavorite: (type: 'channel' | 'contact', id: string) => void;
  onDeleteChannel: (key: string) => void;
  onDeleteContact: (publicKey: string) => void;
}

export function ChatHeader({
  conversation,
  contacts,
  config,
  favorites,
  onTrace,
  onToggleFavorite,
  onDeleteChannel,
  onDeleteContact,
}: ChatHeaderProps) {
  return (
    <div className="flex justify-between items-center px-4 py-2.5 border-b border-border gap-2">
      <span className="flex flex-wrap items-baseline gap-x-2 min-w-0 flex-1">
        <span className="flex-shrink-0 font-semibold text-base">
          {conversation.type === 'channel' &&
          !conversation.name.startsWith('#') &&
          conversation.name !== 'Public'
            ? '#'
            : ''}
          {conversation.name}
        </span>
        <span
          className="font-normal text-[11px] text-muted-foreground font-mono truncate cursor-pointer hover:text-primary transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(conversation.id);
            toast.success(
              conversation.type === 'channel' ? 'Room key copied!' : 'Contact key copied!'
            );
          }}
          title="Click to copy"
        >
          {conversation.type === 'channel' ? conversation.id.toLowerCase() : conversation.id}
        </span>
        {conversation.type === 'contact' &&
          (() => {
            const contact = contacts.find((c) => c.public_key === conversation.id);
            if (!contact) return null;
            const parts: React.ReactNode[] = [];
            if (contact.last_seen) {
              parts.push(`Last heard: ${formatTime(contact.last_seen)}`);
            }
            if (contact.last_path_len === -1) {
              parts.push('flood');
            } else if (contact.last_path_len === 0) {
              parts.push('direct');
            } else if (contact.last_path_len > 0) {
              parts.push(`${contact.last_path_len} hop${contact.last_path_len > 1 ? 's' : ''}`);
            }
            if (isValidLocation(contact.lat, contact.lon)) {
              const distFromUs =
                config && isValidLocation(config.lat, config.lon)
                  ? calculateDistance(config.lat, config.lon, contact.lat, contact.lon)
                  : null;
              parts.push(
                <span key="coords">
                  <span
                    className="font-mono cursor-pointer hover:text-primary hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      const url =
                        window.location.origin +
                        window.location.pathname +
                        getMapFocusHash(contact.public_key);
                      window.open(url, '_blank');
                    }}
                    title="View on map"
                  >
                    {contact.lat!.toFixed(3)}, {contact.lon!.toFixed(3)}
                  </span>
                  {distFromUs !== null && ` (${formatDistance(distFromUs)})`}
                </span>
              );
            }
            return parts.length > 0 ? (
              <span className="font-normal text-sm text-muted-foreground flex-shrink-0">
                (
                {parts.map((part, i) => (
                  <span key={i}>
                    {i > 0 && ', '}
                    {part}
                  </span>
                ))}
                )
              </span>
            ) : null;
          })()}
      </span>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {/* Direct trace button (contacts only) */}
        {conversation.type === 'contact' && (
          <button
            className="p-1.5 rounded hover:bg-accent text-lg leading-none transition-colors"
            onClick={onTrace}
            title="Direct Trace"
          >
            &#x1F6CE;
          </button>
        )}
        {/* Favorite button */}
        {(conversation.type === 'channel' || conversation.type === 'contact') && (
          <button
            className="p-1.5 rounded hover:bg-accent text-lg leading-none transition-colors"
            onClick={() =>
              onToggleFavorite(conversation.type as 'channel' | 'contact', conversation.id)
            }
            title={
              isFavorite(favorites, conversation.type as 'channel' | 'contact', conversation.id)
                ? 'Remove from favorites'
                : 'Add to favorites'
            }
          >
            {isFavorite(favorites, conversation.type as 'channel' | 'contact', conversation.id) ? (
              <span className="text-amber-400">&#9733;</span>
            ) : (
              <span className="text-muted-foreground">&#9734;</span>
            )}
          </button>
        )}
        {/* Delete button */}
        {!(conversation.type === 'channel' && conversation.name === 'Public') && (
          <button
            className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive text-lg leading-none transition-colors"
            onClick={() => {
              if (conversation.type === 'channel') {
                onDeleteChannel(conversation.id);
              } else {
                onDeleteContact(conversation.id);
              }
            }}
            title="Delete"
          >
            &#128465;
          </button>
        )}
      </div>
    </div>
  );
}
