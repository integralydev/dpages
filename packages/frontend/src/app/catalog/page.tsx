'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { DataCard, DataCardActions, DataCardField, DataCardGrid } from '@/components/ui/DataCard';
import { FilterBar } from '@/components/ui/FilterBar';
import { IconButton } from '@/components/ui/IconButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchInput';
import { SimpleDropdown } from '@/components/ui/SimpleDropdown';
import { useCatalog } from '@/hooks/useCatalog';
import { useCategories } from '@/hooks/useCategories';
import type { ProducteApi } from '@/lib/api';
import { formatDecimal } from '@/lib/decimals';
import { MIDA_PAGINA_LLISTATS } from '@/lib/paginacio';

const ALL = 'Tots';
const ALL_FEM = 'Totes';

// Valors fixos del enum real (CHECK constraint, migració 0011) — mateix
// criteri que workshop/page.tsx: no es deriven de `data` perquè amb
// paginació real (MIDA_PAGINA_LLISTATS/pàgina) la pàgina actual pot no contenir tots els
// valors possibles.
const FORMAT_OPTIONS = ['SENCER', 'TALLAT', 'LLESCAT'];
const PACKAGING_OPTIONS = ['NORMAL', 'NORMAL (pes)', 'NORMAL (web)', 'ESPECIAL'];
const STATUS_OPTIONS = ['Actiu', 'Inactiu'];

function formatPrice(value: string | null) {
  const formatted = formatDecimal(value, 2);
  return formatted === '—' ? formatted : `${formatted} €`;
}

function formatWeight(value: string | null) {
  return formatDecimal(value, 3);
}

function distinct(values: string[]) {
  return Array.from(new Set(values));
}

function CatalogCard({ product, onEdit }: { product: ProducteApi; onEdit: () => void }) {
  return (
    <DataCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-900">{product.codi}</p>
          <p className="text-sm text-gray-500">{product.descripcio}</p>
        </div>
        <Badge variant={product.actiu ? 'positive' : 'neutral'}>
          {product.actiu ? 'Actiu' : 'Inactiu'}
        </Badge>
      </div>

      <div className="mt-3">
        <DataCardGrid>
          <DataCardField label="Categoria">{product.categoria?.nom ?? '—'}</DataCardField>
          <DataCardField label="Agrupació producció">
            {product.agrupacioProduccio ?? '—'}
          </DataCardField>
          <DataCardField label="Format">{product.format ?? '—'}</DataCardField>
          <DataCardField label="Envasat">{product.envasat ?? '—'}</DataCardField>
          <DataCardField label="Pes (kg)">{formatWeight(product.pesKg)}</DataCardField>
          <DataCardField label="Preu base">{formatPrice(product.preuVenda)}</DataCardField>
        </DataCardGrid>
      </div>

      <DataCardActions>
        <button
          type="button"
          onClick={onEdit}
          className="w-full rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Editar producte
        </button>
      </DataCardActions>
    </DataCard>
  );
}

export default function CatalogPage() {
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(ALL_FEM);
  const [productionGroup, setProductionGroup] = useState(ALL);
  const [format, setFormat] = useState(ALL);
  const [packaging, setPackaging] = useState(ALL);
  const [status, setStatus] = useState(ALL);

  // Efecte col·lateral de la paginació ja resolt: Categoria i Agrupació
  // producció ja no deriven de `data` (paginat a 20) — es
  // resolen contra fonts completes ja disponibles, mateix patró que
  // Format/Envasat/Estat (constants) però per a valors oberts que no ho
  // poden ser. `useCategories()`/`useCatalog()` acá SENSE `mida: MIDA_PAGINA_LLISTATS` és una
  // segona crida independent (mida per defecte 200), no la mateixa que
  // alimenta la taula.
  const { data: allCategories } = useCategories();
  const { data: allProducts } = useCatalog();
  const categoryOptions = useMemo(
    () => distinct(allCategories.map((category) => category.nom)),
    [allCategories],
  );
  // "—" identifica els productes sense agrupació (`agrupacioProduccio ===
  // null`) — es manté com a opció visible al desplegable, però NO es manda
  // mai com a query param real: `GET /productes?agrupacioProduccio=` fa
  // `LOWER(p.agrupacio_produccio) = LOWER($1)`, que mai matcheja una fila
  // NULL (el backend no té cap manera de demanar "sense agrupació"). Seguir
  // triant "—" avui simplement no filtra res (mostra tots els productes) —
  // limitació real del backend, no d'aquest fix.
  const NO_PRODUCTION_GROUP = '—';
  const productionGroupOptions = useMemo(
    () => distinct(allProducts.map((product) => product.agrupacioProduccio ?? NO_PRODUCTION_GROUP)),
    [allProducts],
  );
  const categoriaId = useMemo(
    () =>
      category !== ALL_FEM ? allCategories.find((item) => item.nom === category)?.id : undefined,
    [category, allCategories],
  );

  // Migració server-side dels 5 filtres: abans Categoria/Agrupació
  // producció/Format/Envasat/Estat es filtraven
  // client-side sobre `data` (només els 20 items de la pàgina actual), així
  // que `useCatalog()` mai detectava un canvi de filtre (no formaven part
  // de `filters`) i `pagina` no es resetejava mai — el total mostrat
  // quedava desfasat i la pàgina 1 podia sortir buida. Mateix criteri que
  // `cerca` (ja server-side des d'abans): tots viatgen com a query params
  // reals de GET /productes (categoriaId/agrupacioProduccio/format/
  // envasat/actiu, confirmat contra productes.ts), `useCatalog()` els
  // detecta via `filtersKey` i reseteja la pàgina sol.
  const filters = useMemo(
    () => ({
      ...(search.trim() ? { cerca: search.trim() } : {}),
      ...(categoriaId !== undefined ? { categoriaId } : {}),
      ...(productionGroup !== ALL && productionGroup !== NO_PRODUCTION_GROUP
        ? { agrupacioProduccio: productionGroup }
        : {}),
      ...(format !== ALL ? { format } : {}),
      ...(packaging !== ALL ? { envasat: packaging } : {}),
      ...(status !== ALL ? { actiu: status === 'Actiu' } : {}),
    }),
    [search, categoriaId, productionGroup, format, packaging, status],
  );
  const { data, paginacio, setPagina, isLoading, error, refetch } = useCatalog(filters, {
    mida: MIDA_PAGINA_LLISTATS,
  });

  return (
    <div>
      <PageHeader
        title="Catàleg"
        subtitle="Manteniment del catàleg de productes."
        action={{
          label: 'Nou producte',
          icon: <Plus className="h-4 w-4" />,
          onClick: () => router.push('/catalog/new'),
        }}
      />

      <FilterBar>
        <SearchInput label="Cerca descripció" value={search} onChange={setSearch} />
        <SimpleDropdown
          label="Categoria"
          allLabel={ALL_FEM}
          options={categoryOptions}
          value={category}
          onChange={setCategory}
        />
        <SimpleDropdown
          label="Agrupació producció"
          allLabel={ALL}
          options={productionGroupOptions}
          value={productionGroup}
          onChange={setProductionGroup}
        />
        <SimpleDropdown
          label="Format"
          allLabel={ALL}
          options={FORMAT_OPTIONS}
          value={format}
          onChange={setFormat}
        />
        <SimpleDropdown
          label="Envasat"
          allLabel={ALL}
          options={PACKAGING_OPTIONS}
          value={packaging}
          onChange={setPackaging}
        />
        <SimpleDropdown
          label="Estat"
          allLabel={ALL}
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
        />
      </FilterBar>

      {isLoading && <p className="text-sm text-gray-500">Carregant...</p>}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">
            No s&apos;ha pogut carregar el catàleg: {error.message}
          </p>
          <button
            type="button"
            onClick={refetch}
            className="shrink-0 rounded-full border border-red-300 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            Torna-ho a provar
          </button>
        </div>
      )}

      {!isLoading && !error && (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {data.map((product) => (
              <CatalogCard
                key={product.id}
                product={product}
                onEdit={() => router.push(`/catalog/${product.id}/edit`)}
              />
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-gray-200">
                <tr>
                  <th className="w-[11%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Categoria
                  </th>
                  <th className="hidden w-[12%] px-2 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Agrupació producció
                  </th>
                  <th className="w-[10%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Codi
                  </th>
                  <th className="w-[18%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Descripció
                  </th>
                  <th className="hidden w-[8%] px-2 py-2 text-left font-medium text-gray-500 break-words xl:table-cell">
                    Format
                  </th>
                  <th className="w-[9%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Envasat
                  </th>
                  <th className="w-[8%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Pes (kg)
                  </th>
                  <th className="w-[9%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Preu base
                  </th>
                  <th className="w-[7%] px-2 py-2 text-left font-medium text-gray-500 break-words">
                    Estat
                  </th>
                  <th className="w-[8%] px-2 py-2 text-right font-medium text-gray-500 break-words">
                    Accions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((product) => (
                  <tr key={product.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-2 py-3 break-words text-gray-900">
                      {product.categoria?.nom ?? '—'}
                    </td>
                    <td className="hidden px-2 py-3 break-words text-gray-900 xl:table-cell">
                      {product.agrupacioProduccio ?? '—'}
                    </td>
                    <td className="px-2 py-3 break-words">
                      <span className="font-semibold text-gray-900">{product.codi}</span>
                    </td>
                    <td className="px-2 py-3 break-words text-gray-900">{product.descripcio}</td>
                    <td className="hidden px-2 py-3 break-words text-gray-900 xl:table-cell">
                      {product.format ?? '—'}
                    </td>
                    <td className="px-2 py-3 break-words text-gray-900">
                      {product.envasat ?? '—'}
                    </td>
                    <td className="px-2 py-3 text-right text-gray-900">
                      {formatWeight(product.pesKg)}
                    </td>
                    <td className="px-2 py-3 text-right text-gray-900">
                      {formatPrice(product.preuVenda)}
                    </td>
                    <td className="px-2 py-3 break-words">
                      <Badge variant={product.actiu ? 'positive' : 'neutral'}>
                        {product.actiu ? 'Actiu' : 'Inactiu'}
                      </Badge>
                    </td>
                    <td className="px-2 py-3 text-right">
                      <div className="flex justify-end">
                        <IconButton
                          variant="edit"
                          label="Editar producte"
                          onClick={() => router.push(`/catalog/${product.id}/edit`)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {paginacio && <Pagination paginacio={paginacio} onPageChange={setPagina} />}
        </>
      )}
    </div>
  );
}
