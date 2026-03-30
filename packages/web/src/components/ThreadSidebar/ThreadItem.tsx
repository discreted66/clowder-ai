import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import type { ThreadState } from '@/stores/chat-types';
import { API_URL } from '@/utils/api-client';
import { CatAvatar } from '../CatAvatar';
import { PawIcon } from '../icons/PawIcon';
import { formatRelativeTime } from './thread-utils';

export interface ThreadItemProps {
  id: string;
  title: string | null;
  participants: string[];
  lastActiveAt: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onTogglePin?: (id: string, pinned: boolean) => void | Promise<void>;
  onToggleFavorite?: (id: string, favorited: boolean) => void | Promise<void>;
  onUpdatePreferredCats?: (id: string, cats: string[]) => void | Promise<void>;
  isPinned?: boolean;
  isFavorited?: boolean;
  threadState?: ThreadState;
  indented?: boolean;
  preferredCats?: string[];
  isHubThread?: boolean;
}

export function ThreadItem({
  id,
  title,
  participants,
  lastActiveAt,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  onToggleFavorite,
  isPinned,
  isFavorited,
  indented,
  isHubThread,
}: ThreadItemProps) {
  const { getCatById } = useCatData();
  const canDelete = id !== 'default' && onDelete;
  const canRename = id !== 'default' && onRename;
  const canPin = id !== 'default' && onTogglePin;
  const canFavorite = id !== 'default' && onToggleFavorite;

  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? '');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (!isEditing) setDraftTitle(title ?? '');
  }, [title, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current) return;
      const target = event.target as Node | null;
      if (target && !menuRef.current.contains(target)) {
        closeMenu();
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('blur', closeMenu);

    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('blur', closeMenu);
    };
  }, [contextMenu]);

  const submitRename = useCallback(async () => {
    if (!onRename) return;
    const next = draftTitle.trim();
    if (!next) {
      setDraftTitle(title ?? '');
      setIsEditing(false);
      return;
    }
    if (next === (title ?? '')) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onRename(id, next);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  }, [onRename, draftTitle, title, id]);

  const displayTitle = title ?? (id === 'default' ? '大厅' : '未命名对话');
  const participantNames = participants.map((catId) => getCatById(catId)?.displayName ?? catId).join(', ');
  const description = participantNames || (isHubThread ? 'Hub 会话' : '暂无会话描述');
  const tag = isPinned ? '置顶' : '全部';

  const tooltipLines = [displayTitle];
  if (participantNames) tooltipLines.push(`参与: ${participantNames}`);
  tooltipLines.push(formatRelativeTime(lastActiveAt, false));
  const tooltip = tooltipLines.join('\n');

  return (
    <div
      className={`ui-thread-item group relative cursor-pointer transition-colors ${
        indented ? 'pl-7 pr-3' : 'px-3'
      } mx-4 border-0 border-b-0 ${isActive ? 'ui-thread-item-active bg-white rounded-[8px]' : 'ui-thread-item-inactive rounded-[8px] hover:bg-[var(--accent-soft)]'}`}
      onClick={() => onSelect(id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      title={tooltip}
    >
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          {participants.length > 0 ? (
            <CatAvatar catId={participants[0]!} size={32} />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--text-muted)]">
              <PawIcon className="h-4 w-4" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {isEditing ? (
            <input
              ref={inputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isComposingRef.current) {
                  e.preventDefault();
                  void submitRename();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraftTitle(title ?? '');
                  setIsEditing(false);
                }
              }}
              onBlur={() => {
                void submitRename();
              }}
              disabled={isSaving}
              maxLength={200}
              className="ui-field w-full px-2 py-1 text-[13px] disabled:opacity-70"
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="ui-thread-title block min-w-0 flex-1 truncate">{displayTitle}</span>
                <span
                  className={`ui-thread-meta shrink-0 rounded px-1.5 py-0.5 ${
                    isPinned ? 'bg-[#e8f3ff] text-[#1476ef]' : 'bg-[#f0f0f0] text-[#191919]'
                  }`}
                >
                  {tag}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="block min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">{description}</span>
                <span className="ui-thread-meta shrink-0">{formatRelativeTime(lastActiveAt, true)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 inline-block rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {canRename && !isEditing && (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                setIsEditing(true);
              }}
              className="block whitespace-nowrap rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent-soft)]"
            >
              重命名
            </button>
          )}

          {canPin && (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                void onTogglePin?.(id, !isPinned);
              }}
              className="block whitespace-nowrap rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent-soft)]"
            >
              {isPinned ? '取消置顶' : '置顶'}
            </button>
          )}

          {canFavorite && (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                void onToggleFavorite?.(id, !isFavorited);
              }}
              className="block whitespace-nowrap rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent-soft)]"
            >
              {isFavorited ? '取消收藏' : '收藏'}
            </button>
          )}

          {id !== 'default' && (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                window.open(`${API_URL}/api/export/thread/${id}?format=md`);
              }}
              className="block whitespace-nowrap rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent-soft)]"
            >
              导出对话
            </button>
          )}

          {canDelete && (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                onDelete?.(id);
              }}
              className="block whitespace-nowrap rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent-soft)]"
            >
              删除对话
            </button>
          )}
        </div>
      )}
    </div>
  );
}
