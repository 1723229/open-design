import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { MarqueeLabel } from './MarqueeLabel';
import styles from './EntryNavRail.module.css';

interface Props {
  name: string;
  items: readonly { id: string; name: string; disabled?: boolean }[];
  activeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  loading?: boolean;
  headerMeta?: ReactNode;
  children?: ReactNode;
}

/** The entry rail's workspace menu, shared by Cloud and local team accounts. */
export function EntryWorkspaceSwitcher({ name, items, activeId, open, onOpenChange, onSelect, loading, headerMeta, children }: Props) {
  const t = useT();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  function close() {
    onOpenChange(false);
    trigger.current?.focus();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const menuItems = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    if (!menuItems.length) return;
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? menuItems.length - 1
      : event.key === 'ArrowUp' ? (currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex >= menuItems.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    menuItems[nextIndex]?.focus();
  }
  return <div className="entry-nav-rail__team-wrap" onKeyDown={event => { if (open) handleKeyDown(event); }}>
    <button ref={trigger} type="button" className="entry-nav-rail__team" onClick={() => onOpenChange(!open)}
      aria-label={name} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} data-testid="workspace-switcher">
      <span className="entry-nav-rail__team-avatar" aria-hidden>{name.charAt(0).toUpperCase() || 'W'}</span>
      <MarqueeLabel className="entry-nav-rail__team-name" text={name} />
      <span className="entry-nav-rail__team-chevron" aria-hidden><Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /></span>
    </button>
    {open && <>
      <div className="entry-nav-rail__menu-backdrop" onClick={close} />
      <div id={id} className={`entry-nav-rail__team-menu ${styles.workspaceMenu}`} role="menu" aria-label={t('workspaceSwitcher.title')}>
        <div className={styles.workspaceMenuHead}><span>{t('workspaceSwitcher.title')}</span>{headerMeta}</div>
        <div className="entry-nav-rail__workspace-list" data-testid="workspace-switcher-list">
          {items.map(item => <button key={item.id} type="button" className={`entry-nav-rail__menu-item${item.id === activeId ? ' is-current' : ''}`}
            role="menuitem" aria-label={item.name} aria-current={item.id === activeId ? 'true' : undefined} disabled={item.disabled} onClick={() => onSelect(item.id)}>
            <span className="entry-nav-rail__team-avatar" aria-hidden>{item.name.charAt(0).toUpperCase() || 'W'}</span>
            <MarqueeLabel className="entry-nav-rail__workspace-menu-name" text={item.name} />
            {item.id === activeId && <span className={styles.workspaceSelectedMark}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M9.9997 15.1709L19.1921 5.97852L20.6063 7.39273L9.9997 17.9993L3.63574 11.6354L5.04996 10.2212L9.9997 15.1709Z" /></svg></span>}
          </button>)}
          {loading && !items.length && <div className="entry-nav-rail__menu-item is-muted" role="status">{t('common.loading')}</div>}
        </div>
        {children && <div className="entry-nav-rail__workspace-actions" data-testid="workspace-switcher-actions"><div className="entry-nav-rail__menu-divider" />{children}</div>}
      </div>
    </>}
  </div>;
}
