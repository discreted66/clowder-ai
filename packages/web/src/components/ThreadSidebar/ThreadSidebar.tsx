'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { BootcampIcon } from '../icons/BootcampIcon';
import { HubIcon } from '../icons/HubIcon';
import { TaskPanel } from '../TaskPanel';
import { UserProfile } from '../UserProfile';
import { DirectoryPickerModal, type NewThreadOptions } from './DirectoryPickerModal';
import { SectionGroup } from './SectionGroup';
import { ThreadItem } from './ThreadItem';
import { getProjectPaths, type ThreadGroup } from './thread-utils';
import { createToggleWithReconcile } from './toggle-with-reconcile';
import { useCollapseState } from './use-collapse-state';
import { useProjectPins } from './use-project-pins';

interface ThreadSidebarProps {
  onClose?: () => void;
  className?: string;
  onBootcampClick?: () => void;
  onHubClick?: () => void;
  onMenuClick?: (menu: 'models' | 'agents' | 'channels' | 'skills') => void;
  activeMenu?: 'models' | 'agents' | 'channels' | 'skills';
}

export function ThreadSidebar({
  onClose,
  className,
  onBootcampClick,
  onHubClick,
  onMenuClick,
  activeMenu,
}: ThreadSidebarProps) {
  const router = useRouter();
  const {
    threads,
    currentThreadId,
    setThreads,
    setCurrentProject,
    isLoadingThreads,
    setLoadingThreads,
    updateThreadTitle,
    getThreadState,
    threadStates,
  } = useChatStore();
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [bindWarning, setBindWarning] = useState<string | null>(null);
  // I-1: Thread to confirm deletion (null = no dialog)
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null);
  // F095 Phase D: Trash bin state
  const [showTrash, setShowTrash] = useState(false);
  const [trashedThreads, setTrashedThreads] = useState<Thread[]>([]);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  // F070: governance health by project path
  const [govHealth, setGovHealth] = useState<Record<string, string>>({});

  // Shared seq maps 鈥?created once, cross-referenced between pin/fav toggle instances
  const pinSeqMap = useRef(new Map<string, number>());
  const favSeqMap = useRef(new Map<string, number>());

  // Stable toggle-with-reconcile instances (lazy-init in ref, survive re-renders)
  const pinToggle = useRef<ReturnType<typeof createToggleWithReconcile>>();
  const favToggle = useRef<ReturnType<typeof createToggleWithReconcile>>();
  if (!pinToggle.current) {
    pinToggle.current = createToggleWithReconcile({
      fetch: apiFetch,
      onUpdate: (id, val) => useChatStore.getState().updateThreadPin(id, val),
      field: 'pinned',
      seqMap: pinSeqMap.current,
      siblingSeqMap: favSeqMap.current,
      onUpdateSibling: (id, val) => useChatStore.getState().updateThreadFavorite(id, val),
      siblingField: 'favorited',
    });
  }
  if (!favToggle.current) {
    favToggle.current = createToggleWithReconcile({
      fetch: apiFetch,
      onUpdate: (id, val) => useChatStore.getState().updateThreadFavorite(id, val),
      field: 'favorited',
      seqMap: favSeqMap.current,
      siblingSeqMap: pinSeqMap.current,
      onUpdateSibling: (id, val) => useChatStore.getState().updateThreadPin(id, val),
      siblingField: 'pinned',
    });
  }

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const res = await apiFetch('/api/threads');
      if (!res.ok) return;
      const data = await res.json();
      const threads = data.threads ?? [];
      setThreads(threads);
      // F069: Restore unread state from API
      const { initThreadUnread } = useChatStore.getState();
      for (const thread of threads) {
        if (thread.unreadCount > 0 || thread.hasUserMention) {
          initThreadUnread(thread.id, thread.unreadCount ?? 0, !!thread.hasUserMention);
        }
      }
    } catch {
      // Silently ignore
    } finally {
      setLoadingThreads(false);
    }
  }, [setThreads, setLoadingThreads]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // F070: Fetch governance health for all registered external projects
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/governance/health');
        if (!res.ok) return;
        const data = (await res.json()) as { projects: { projectPath: string; status: string }[] };
        const map: Record<string, string> = {};
        for (const p of data.projects) {
          map[p.projectPath] = p.status;
        }
        setGovHealth(map);
      } catch {
        // Best effort
      }
    })();
  }, []);

  const navigateToThread = useCallback(
    (threadId: string) => {
      router.push(threadId === 'default' ? '/' : `/thread/${threadId}`);
    },
    [router],
  );

  const createInProject = useCallback(
    async (opts: NewThreadOptions) => {
      setIsCreating(true);
      setShowPicker(false);
      try {
        const res = await apiFetch(`/api/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
            ...(opts.preferredCats?.length ? { preferredCats: opts.preferredCats } : {}),
            ...(opts.title ? { title: opts.title } : {}),
            ...(opts.pinned ? { pinned: opts.pinned } : {}),
            ...(opts.backlogItemId ? { backlogItemId: opts.backlogItemId } : {}),
          }),
        });
        if (!res.ok) return;
        const thread: Thread = await res.json();

        // F33: Bind external sessions after thread creation (best-effort, parallel)
        if (opts.sessionBindings?.length) {
          const results = await Promise.allSettled(
            opts.sessionBindings.map(({ catId, cliSessionId }) =>
              apiFetch(`/api/threads/${thread.id}/sessions/${catId}/bind`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cliSessionId }),
              }),
            ),
          );
          const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
          if (failed.length > 0) {
            setBindWarning(`Session 缁戝畾閮ㄥ垎澶辫触锛?{failed.length}/${results.length}锛夛紝鍙湪 Session 闈㈡澘閲嶈瘯`);
            setTimeout(() => setBindWarning(null), 6000);
          }
        }

        if (opts.projectPath) setCurrentProject(opts.projectPath);
        navigateToThread(thread.id);
        // Auto-close sidebar on mobile after creating a new conversation
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          onClose?.();
        }
        await loadThreads();
      } catch {
        // Silently ignore
      } finally {
        setIsCreating(false);
      }
    },
    [setCurrentProject, navigateToThread, loadThreads, onClose],
  );

  // F095 Phase D: Load trashed threads
  const loadTrash = useCallback(async () => {
    setIsLoadingTrash(true);
    try {
      const res = await apiFetch('/api/threads?deleted=true');
      if (!res.ok) return;
      const data = await res.json();
      setTrashedThreads(data.threads ?? []);
    } catch {
      // Silently ignore
    } finally {
      setIsLoadingTrash(false);
    }
  }, []);

  const handleToggleTrash = useCallback(() => {
    setShowTrash((prev) => {
      const next = !prev;
      if (next) void loadTrash();
      return next;
    });
  }, [loadTrash]);

  const handleRestore = useCallback(
    async (threadId: string) => {
      try {
        const res = await apiFetch(`/api/threads/${threadId}/restore`, { method: 'POST' });
        if (!res.ok) return;
        await loadThreads();
        await loadTrash();
      } catch {
        // Silently ignore
      }
    },
    [loadThreads, loadTrash],
  );

  /** F087: Create a bootcamp onboarding thread */
  const createBootcampThread = useCallback(async () => {
    setIsCreating(true);
    try {
      const res = await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '🎓 猫猫训练营',
          bootcampState: {
            v: 1,
            phase: 'phase-0-select-cat',
            startedAt: Date.now(),
          },
        }),
      });
      if (!res.ok) return;
      const thread: Thread = await res.json();
      navigateToThread(thread.id);
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        onClose?.();
      }
      await loadThreads();
    } catch {
      // Silently ignore
    } finally {
      setIsCreating(false);
    }
  }, [navigateToThread, loadThreads, onClose]);

  // I-1: Show confirmation dialog instead of deleting immediately
  const handleDeleteRequest = useCallback(
    (threadId: string) => {
      const thread = threads.find((t) => t.id === threadId);
      if (thread) setDeleteTarget(thread);
    },
    [threads],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const threadId = deleteTarget.id;
    setDeleteTarget(null);
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) return;
      if (threadId === currentThreadId) {
        navigateToThread('default');
      }
      await loadThreads();
      // F095 Phase D: Refresh trash bin if visible
      if (showTrash) void loadTrash();
    } catch {
      // Silently ignore
    }
  }, [deleteTarget, currentThreadId, navigateToThread, loadThreads, showTrash, loadTrash]);

  const handleRename = useCallback(
    async (threadId: string, title: string) => {
      const nextTitle = title.trim();
      if (!nextTitle) return;
      try {
        const res = await apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
        });
        if (!res.ok) return;
        const updated = await res.json();
        updateThreadTitle(threadId, updated.title ?? nextTitle);
      } catch {
        // Silently ignore
      }
    },
    [updateThreadTitle],
  );

  const handleTogglePin = useCallback(
    (threadId: string, pinned: boolean) => void pinToggle.current?.toggle(threadId, pinned),
    [],
  );

  const handleToggleFavorite = useCallback(
    (threadId: string, favorited: boolean) => void favToggle.current?.toggle(threadId, favorited),
    [],
  );

  const handleUpdatePreferredCats = useCallback(async (threadId: string, cats: string[]) => {
    const res = await apiFetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredCats: cats }),
    });
    if (!res.ok) throw new Error('保存失败');
    useChatStore.getState().updateThreadPreferredCats(threadId, cats);
  }, []);

  const handleSelect = useCallback(
    (threadId: string) => {
      if (threadId === currentThreadId) return;
      // B1.1: Restore projectPath from thread metadata on switch
      const target = threads.find((t) => t.id === threadId);
      setCurrentProject(target?.projectPath ?? 'default');
      navigateToThread(threadId);
      // Auto-close sidebar on mobile after selecting a thread
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        onClose?.();
      }
    },
    [currentThreadId, threads, setCurrentProject, navigateToThread, onClose],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredThreads = useMemo(() => {
    if (!normalizedQuery) return threads;
    return threads.filter((thread) => {
      const title = (thread.title ?? '').toLowerCase();
      const fallback = (thread.id === 'default' ? '大厅' : '未命名对话').toLowerCase();
      const project = (thread.projectPath ?? '').toLowerCase();
      const threadId = thread.id.toLowerCase();
      return (
        title.includes(normalizedQuery) ||
        fallback.includes(normalizedQuery) ||
        project.includes(normalizedQuery) ||
        threadId.includes(normalizedQuery)
      );
    });
  }, [threads, normalizedQuery]);

  const unreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      const ts = threadStates[thread.id];
      if (ts && ts.unreadCount > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [threads, threadStates]);

  // F072: Mark all threads as read
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const handleMarkAllRead = useCallback(async () => {
    setIsMarkingAllRead(true);
    try {
      const res = await apiFetch('/api/threads/read/mark-all', { method: 'POST' });
      if (res.ok) {
        useChatStore.getState().clearAllUnread();
      }
    } catch (err) {
      console.debug('[F072] mark-all-read failed:', err);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, []);

  // Sidebar grouping: only "全部" and "置顶"
  const { pinnedProjects, toggleProjectPin } = useProjectPins();
  const threadGroups = useMemo<ThreadGroup[]>(() => {
    const sortable = filteredThreads.filter((t) => t.id !== 'default');
    const sortedAll = [...sortable].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const sortedPinned = sortedAll.filter((t) => t.pinned);
    const sortedUnpinned = sortedAll.filter((t) => !t.pinned);
    const groups: ThreadGroup[] = [];
    if (sortedPinned.length > 0) {
      groups.push({ type: 'pinned' as const, label: '置顶', threads: sortedPinned });
    }
    groups.push({ type: 'recent' as const, label: '全部', threads: sortedUnpinned });
    return groups;
  }, [filteredThreads]);
  const displayThreadGroups = useMemo(() => {
    if (sortOrder === 'desc') return threadGroups;
    return threadGroups.map((group) => ({
      ...group,
      threads: [...group.threads].sort((a, b) => a.lastActiveAt - b.lastActiveAt),
      archivedGroups: group.archivedGroups?.map((sub) => ({
        ...sub,
        threads: [...sub.threads].sort((a, b) => a.lastActiveAt - b.lastActiveAt),
      })),
    }));
  }, [threadGroups, sortOrder]);
  const existingProjects = useMemo(() => getProjectPaths(threads), [threads]);
  const showDefaultThread = normalizedQuery.length === 0 || '大厅'.includes(normalizedQuery);

  // F095: Collapse state with localStorage persistence + search/active auto-expand
  const { isCollapsed, toggleGroup } = useCollapseState({
    threadGroups,
    searchQuery: normalizedQuery,
    currentThreadId,
  });
  const isChatMenu = !activeMenu;
  const menuItemBase = 'ui-menu-item flex w-full items-center gap-1.5 px-2.5 transition-colors';
  const chatMenuItemBase = 'ui-menu-item flex min-w-0 flex-1 items-center gap-1.5 px-2.5 transition-colors';
  const menuItemActive = 'ui-menu-item-active';
  const menuItemInactive = 'ui-menu-item-inactive';

  return (
    <>
      <aside className={`${className ?? 'w-[248px]'} ui-sidebar-shell flex h-full flex-col`}>
        <div className="ui-sidebar-section flex items-center justify-between px-3 py-4 border-0">
          <div className="flex items-center gap-2">
            <img src="/images/lobster.svg" alt="OfficeClaw" className="w-9 h-9 rounded-lg" />
            <span className="text-[var(--font-size-hero)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">OfficeClaw</span>
          </div>
        </div>

        <div className="ui-sidebar-section hidden px-3 py-2">
          <button
            type="button"
            onClick={() => {
              const fromParam = currentThreadId ? `?from=${encodeURIComponent(currentThreadId)}` : '';
              router.push(`/mission-hub${fromParam}`);
              if (typeof window !== 'undefined' && window.innerWidth < 768) {
                onClose?.();
              }
            }}
            className="flex w-full items-center gap-2 rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-left text-xs font-medium text-[#4B5563] transition-colors hover:bg-[#F9FAFB] hover:text-[#111827]"
            data-testid="sidebar-mission-control"
          >
            <svg
              className="h-4 w-4 shrink-0 text-[#9CA3AF]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            Mission Hub
          </button>
        </div>

        <div className="ui-sidebar-section px-3 py-2.5">
          <div className="flex flex-col gap-1.5 items-start">
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              className={`flex items-center gap-1.5 text-sm font-semibold transition-colors w-full px-2.5 py-1 text-cafe-black hover:text-cocreator-primary`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              新建会话
            </button>
            <button
              type="button"
              onClick={() => onMenuClick?.('models')}
              className={`${menuItemBase} ${activeMenu === 'models' ? menuItemActive : menuItemInactive} text-cafe-black hover:text-cocreator-primary`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              模型
            </button>
            <button
              type="button"
              onClick={() => onMenuClick?.('agents')}
              className={`${menuItemBase} ${activeMenu === 'agents' ? menuItemActive : menuItemInactive} text-cafe-black hover:text-cocreator-primary`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <circle cx="19" cy="12" r="2" />
                <circle cx="5" cy="12" r="2" />
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
              智能体
            </button>
            <button
              type="button"
              onClick={() => onMenuClick?.('channels')}
              className={`${menuItemBase} ${activeMenu === 'channels' ? menuItemActive : menuItemInactive} text-cafe-black hover:text-cocreator-primary`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                <path d="M8 9h8M8 13h6" />
              </svg>
              渠道
            </button>
            <button
              type="button"
              onClick={() => onMenuClick?.('skills')}
              className={`${menuItemBase} ${activeMenu === 'skills' ? menuItemActive : menuItemInactive} text-cafe-black hover:text-cocreator-primary`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.064 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
              </svg>
              技能
            </button>
          </div>
        </div>

        {bindWarning && (
          <div className="px-3 py-1.5 bg-yellow-50 border-b border-yellow-200 text-[10px] text-yellow-700">
            {bindWarning}
          </div>
        )}

        <div className="px-4 pt-2 pb-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-[var(--text-secondary)]">会话消息</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                className={`rounded p-1 transition-colors ${sortOrder === 'asc' ? 'bg-[var(--accent-soft)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-accent)]'}`}
                title={sortOrder === 'desc' ? '按时间升序' : '按时间降序'}
                data-testid="thread-sort-toggle"
              >
                <svg className="h-3.5 w-3.5 align-middle" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
                  <path d="M582.4 529.92c0-18.8416 6.4512-37.1712 18.2272-51.9168l182.3744-227.9936a19.2 19.2 0 0 0 4.1984-11.9808V204.8A19.2 19.2 0 0 0 768 185.6H256A19.2 19.2 0 0 0 236.8 204.8v33.28c0 4.3008 1.4848 8.5504 4.1984 11.9296L423.424 478.0032c11.776 14.7456 18.2272 33.0752 18.2272 51.968v257.5872c0 7.2704 4.096 13.9264 10.5984 17.152l130.2016 65.1264V529.92zM256 121.6512h512c45.9264 0 83.2 37.2736 83.2 83.2v33.28c0 18.8416-6.4512 37.1712-18.2272 51.9168l-182.3744 227.9936a19.2 19.2 0 0 0-4.1984 11.9808v350.208a57.6 57.6 0 0 1-83.3536 51.5072l-139.4688-69.7344a83.2 83.2 0 0 1-45.9776-74.3936v-257.5872a19.2 19.2 0 0 0-4.1984-11.9808L190.976 289.9968a83.2 83.2 0 0 1-18.2272-51.968V204.8c0-45.9264 37.2736-83.2 83.2-83.2z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setIsSearchOpen((prev) => !prev)}
                className={`rounded p-1 transition-colors ${isSearchOpen || normalizedQuery.length > 0 ? 'bg-[var(--accent-soft)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-accent)]'}`}
                title="搜索会话"
                data-testid="thread-search-toggle"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
              </button>
            </div>
          </div>
          {(isSearchOpen || normalizedQuery.length > 0) && (
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话、项目或 ID..."
              autoComplete="off"
              className="ui-field w-full px-2.5 py-1.5 text-[13px] placeholder:text-[var(--text-muted)]"
            />
          )}
          {unreadIds.size > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={isMarkingAllRead}
              className="mt-1.5 text-[var(--font-size-xs)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-accent)] disabled:opacity-40"
              data-testid="mark-all-read-btn"
            >
              {isMarkingAllRead ? '清理中...' : '全部已读'}
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoadingThreads && threads.length === 0 && (
            <div className="text-center py-4 text-xs text-gray-400">加载中...</div>
          )}

          {false && showDefaultThread && (
            <ThreadItem
              id="default"
              title="大厅"
              participants={[]}
              lastActiveAt={Date.now()}
              isActive={currentThreadId === 'default'}
              onSelect={handleSelect}
              threadState={getThreadState('default')}
            />
          )}

          {displayThreadGroups.map((group) => {
            const groupKey = group.projectPath ?? group.type;
            const icon =
              group.type === 'favorites'
                ? ('star' as const)
                : group.type === 'archived-container'
                  ? ('archive' as const)
                  : undefined;

            // Archived container: render nested project groups
            if (group.type === 'archived-container') {
              return (
                <SectionGroup
                  key="archived-container"
                  label={group.label}
                  icon="archive"
                  count={group.archivedGroups?.length ?? 0}
                  isCollapsed={isCollapsed('archived-container')}
                  onToggle={() => toggleGroup('archived-container')}
                >
                  {group.archivedGroups?.map((sub) => {
                    const subKey = sub.projectPath ?? sub.type;
                    return (
                      <SectionGroup
                        key={subKey}
                        label={sub.label}
                        count={sub.threads.length}
                        isCollapsed={isCollapsed(subKey)}
                        onToggle={() => toggleGroup(subKey)}
                        projectPath={sub.projectPath}
                        governanceStatus={sub.projectPath ? govHealth[sub.projectPath] : undefined}
                        onToggleProjectPin={sub.projectPath ? () => toggleProjectPin(sub.projectPath!) : undefined}
                        isProjectPinned={sub.projectPath ? pinnedProjects.has(sub.projectPath) : undefined}
                      >
                        {sub.threads.map((t) => (
                          <ThreadItem
                            key={t.id}
                            id={t.id}
                            title={t.title}
                            participants={t.participants}
                            lastActiveAt={t.lastActiveAt}
                            isActive={currentThreadId === t.id}
                            onSelect={handleSelect}
                            onDelete={handleDeleteRequest}
                            onRename={handleRename}
                            onTogglePin={handleTogglePin}
                            onToggleFavorite={handleToggleFavorite}
                            onUpdatePreferredCats={handleUpdatePreferredCats}
                            isPinned={t.pinned}
                            isFavorited={t.favorited}
                            threadState={getThreadState(t.id)}
                            indented
                            preferredCats={t.preferredCats}
                            isHubThread={!!t.connectorHubState}
                          />
                        ))}
                      </SectionGroup>
                    );
                  })}
                </SectionGroup>
              );
            }

            return (
              <SectionGroup
                key={groupKey}
                label={group.label}
                icon={icon}
                count={group.threads.length}
                isCollapsed={group.type === 'pinned' || group.type === 'recent' ? false : isCollapsed(groupKey)}
                onToggle={group.type === 'pinned' || group.type === 'recent' ? () => {} : () => toggleGroup(groupKey)}
                hideToggle={group.type === 'pinned' || group.type === 'recent'}
                hideCount={group.type === 'pinned' || group.type === 'recent'}
                projectPath={group.projectPath}
                governanceStatus={group.projectPath ? govHealth[group.projectPath] : undefined}
                onToggleProjectPin={
                  group.type === 'project' && group.projectPath ? () => toggleProjectPin(group.projectPath!) : undefined
                }
                isProjectPinned={
                  group.type === 'project' && group.projectPath ? pinnedProjects.has(group.projectPath) : undefined
                }
              >
                {group.threads.map((t) => (
                  <ThreadItem
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    participants={t.participants}
                    lastActiveAt={t.lastActiveAt}
                    isActive={currentThreadId === t.id}
                    onSelect={handleSelect}
                    onDelete={handleDeleteRequest}
                    onRename={handleRename}
                    onTogglePin={handleTogglePin}
                    onToggleFavorite={handleToggleFavorite}
                    onUpdatePreferredCats={handleUpdatePreferredCats}
                    isPinned={t.pinned}
                    isFavorited={t.favorited}
                    threadState={getThreadState(t.id)}
                    indented={group.type === 'project'}
                    preferredCats={t.preferredCats}
                    isHubThread={!!t.connectorHubState}
                  />
                ))}
              </SectionGroup>
            );
          })}

          {normalizedQuery.length > 0 && threadGroups.length === 0 && !showDefaultThread && (
            <div className="px-3 py-4 text-xs text-gray-400">没有匹配的对话</div>
          )}
        </div>

        {/* 回收站入口暂时隐藏 */}

        <div className="border-t border-[var(--border-default)]"></div>

        <UserProfile />

        <TaskPanel />
      </aside>

      {showPicker && (
        <DirectoryPickerModal
          existingProjects={existingProjects}
          onSelect={createInProject}
          onCancel={() => setShowPicker(false)}
        />
      )}

      {/* I-1: Delete confirmation dialog */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setDeleteTarget(null)}
        >
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-2">确认删除对话</h3>
            <p className="text-sm text-gray-600 mb-1">即将删除「{deleteTarget.title ?? '未命名对话'}」</p>
            <p className="text-xs text-gray-500 mb-4">对话将移入回收站，30 天后自动清理。你可以随时从回收站恢复。</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm text-white transition-colors hover:bg-orange-600"
              >
                移入回收站
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

