'use client';

import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  Beef,
  BookOpen,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  ContactRound,
  Euro,
  Factory,
  FolderTree,
  Menu,
  PackageCheck,
  PiggyBank,
  ShoppingCart,
  Truck,
  UserCog,
  X,
} from 'lucide-react';
import { GuardedLink } from '@/components/ui/GuardedLink';
import { useAuth } from '@/hooks/useAuth';
import { useNavigationGuard } from '@/hooks/useNavigationGuard';

type NavItem = {
  label: string;
  href: string;
  /** Clave de `modulsPermesos` (contrato §4.12) que habilita este ítem — ver lib/roles.ts (MODUL_ROUTES). */
  modul: string;
  icon: ComponentType<{ className?: string }>;
};

// Comandes queda solta, primera i destacada (mateixa jerarquia visual que ja
// tenia) — no forma part de cap grup.
const STANDALONE_ITEM: NavItem = {
  label: 'Comandes',
  href: '/orders',
  modul: 'comandes',
  icon: ShoppingCart,
};

type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Catàleg',
    items: [
      { label: 'Categories', href: '/categories', modul: 'categories', icon: FolderTree },
      { label: 'Catàleg', href: '/catalog', modul: 'catalog', icon: BookOpen },
      {
        label: 'Rendiments Porcs',
        href: '/pig-yields',
        modul: 'rendiments-porcs',
        icon: PiggyBank,
      },
    ],
  },
  {
    label: 'Tarifes',
    items: [
      { label: 'Llistat de Tarifes', href: '/rates', modul: 'tarifes', icon: Euro },
      {
        label: 'Tarifes per client',
        href: '/client-tariffs',
        modul: 'tarifes-clients',
        icon: ContactRound,
      },
    ],
  },
  {
    label: 'Panells',
    // Una icona per panell, relacionada amb el que s'hi fa: oficina,
    // elaboració de la carn, caixes preparades i producció.
    items: [
      { label: 'Panell Oficina', href: '/office', modul: 'panell-oficina', icon: Briefcase },
      { label: 'Panell Obrador', href: '/workshop', modul: 'panell-obrador', icon: Beef },
      {
        label: 'Panell Empaquetat',
        href: '/packaging',
        modul: 'panell-empaquetat',
        icon: PackageCheck,
      },
      {
        label: 'Panell Producció',
        href: '/production',
        modul: 'panell-produccio',
        icon: Factory,
      },
    ],
  },
  {
    label: 'Configuració',
    items: [
      { label: "Administració d'usuaris", href: '/users', modul: 'usuaris', icon: UserCog },
      { label: 'Transportistes', href: '/transportistes', modul: 'transportistes', icon: Truck },
    ],
  },
];

function NavLink({
  item,
  pathname,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const active = pathname === item.href;
  const Icon = item.icon;
  return (
    <GuardedLink
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] leading-tight font-medium transition-colors ${
        active ? 'bg-brand font-semibold text-carbon' : 'text-gray-200 hover:bg-white/10'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </GuardedLink>
  );
}

// Encabezat no interactiu a propòsit (ni col·lapsable ni clicable) — el
// pedido prioritza simple sobre elaborat, i amb com a molt 4 ítems per grup
// no fa falta plegar-los. `spaced` evita un marge superior buit quan és el
// primer bloc visible de tots (Comandes ocult + primer grup, o primer grup
// a seques).
function NavGroupHeader({ label, spaced }: { label: string; spaced: boolean }) {
  return (
    <p
      className={`px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 ${spaced ? 'mt-3' : 'mt-0'}`}
    >
      {label}
    </p>
  );
}

function UserMenu({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { isDirty, confirmNavigation } = useNavigationGuard();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node))
        setOpen(false);
    }

    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!user) return null;

  const initial = user.nom.trim().charAt(0).toUpperCase() || '?';

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          <GuardedLink
            href="/profile"
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Veure perfil
          </GuardedLink>
          <button
            type="button"
            onClick={() => {
              const doLogout = () => {
                setOpen(false);
                onNavigate?.();
                logout();
                router.replace('/login');
              };
              // Tancar sessió també abandona qualsevol formulari obert
              // (issue #15) — no és un <Link>, així que GuardedLink no
              // l'intercepta sol: passa pel mateix confirmNavigation a mà.
              if (isDirty) {
                confirmNavigation(doLogout);
              } else {
                doLogout();
              }
            }}
            className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            Tancar sessió
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-white/10 ${collapsed ? 'justify-center' : ''}`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-light text-sm font-semibold text-carbon">
          {initial}
        </span>
        {!collapsed && (
          <span
            title={user.nom}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-white"
          >
            {user.nom}
          </span>
        )}
      </button>
    </div>
  );
}

function SidebarContent({
  collapsed,
  onNavigate,
  onToggleCollapse,
  onClose,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const modulsPermesos = user?.rol.modulsPermesos ?? [];
  const standaloneVisible = modulsPermesos.includes(STANDALONE_ITEM.modul);
  // Grup sencer fora si cap dels seus ítems és visible pel rol actual — mai
  // es renderitza un títol de grup sense entrades a sota.
  const visibleGroups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => modulsPermesos.includes(item.modul)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      {/* Franja grafit com la capçalera de dpages.cat: el logotip és rosa
          clar i sobre fons blanc o carbó no es llegiria prou. */}
      <div
        className={`mb-4 flex shrink-0 items-center bg-graphite px-5 pt-6 pb-5 ${collapsed ? 'justify-center' : 'justify-between'}`}
      >
        {!collapsed && (
          <div>
            <Image
              src="/brand/dpages-logotip.png"
              alt="dpagès"
              width={313}
              height={112}
              priority
              className="h-9 w-auto"
            />
            <p className="mt-1.5 text-xs tracking-wide text-gray-200">Gestió de comandes</p>
          </div>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expandir menú' : 'Col·lapsar menú'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/20 text-gray-200 hover:bg-white/10"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Tancar menú"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/20 text-gray-200 hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* flex-1 min-h-0 és imprescindible: sense min-h-0 un fill de flex mai
          es comprimeix per sota de l'alçada del seu contingut (encara que
          tingui overflow-y-auto), i la llista es desborda per sota del
          contenidor en comptes de scrollejar — mateix patró que Modal.tsx. */}
      <nav className="sidebar-nav-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2">
        {standaloneVisible && (
          <NavLink
            item={STANDALONE_ITEM}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        )}
        {visibleGroups.map((group, index) => {
          const somethingBefore = index > 0 || standaloneVisible;
          return (
            <div key={group.label} className="flex flex-col gap-1">
              {collapsed ? (
                somethingBefore && <div className="my-2 border-t border-white/10" />
              ) : (
                <NavGroupHeader label={group.label} spaced={somethingBefore} />
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-white/10 px-3 pt-3 pb-4">
        <UserMenu collapsed={collapsed} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-graphite px-4 lg:hidden">
        <Image
          src="/brand/dpages-logotip.png"
          alt="dpagès · Gestió de comandes"
          width={313}
          height={112}
          priority
          className="h-7 w-auto"
        />
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Obrir menú"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-white/20 text-gray-200"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {mobileOpen && (
        <div
          role="presentation"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 transform bg-carbon transition-transform duration-200 lg:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarContent
          collapsed={false}
          onNavigate={() => setMobileOpen(false)}
          onClose={() => setMobileOpen(false)}
        />
      </aside>

      <aside
        className={`sticky top-0 hidden h-screen shrink-0 bg-carbon transition-all duration-200 lg:block ${
          collapsed ? 'w-20' : 'w-72'
        }`}
      >
        <SidebarContent
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
        />
      </aside>
    </>
  );
}
