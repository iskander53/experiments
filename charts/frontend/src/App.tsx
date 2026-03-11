import { useEffect, useState, useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import "./App.css";

const DIMENSION_OPTIONS = [
  "stage",
  "deviation_category",
  "deviation",
  "warehouse",
  "customer",
  "employee",
  "item_type",
  "day",
  "week",
  "month",
  "hour",
  "shift",
] as const;

const DIM_LABELS: Record<string, string> = {
  stage: "Этап",
  deviation_category: "Тип отклонения",
  deviation: "Подтип отклонения",
  warehouse: "Терминал",
  customer: "Заказчик",
  employee: "Сотрудник",
  item_type: "Тип товара",
  day: "День",
  week: "Неделя",
  month: "Месяц",
  hour: "Час",
  shift: "Смена",
};

// Group dimensions for filter sidebar
const FILTER_SECTIONS: { title: string; dims: readonly (typeof DIMENSION_OPTIONS)[number][] }[] = [
  { title: "Время", dims: ["hour", "shift", "day", "week", "month"] },
  { title: "Операции", dims: ["stage", "deviation_category", "deviation"] },
  { title: "Организация", dims: ["warehouse", "customer", "employee", "item_type"] },
];


const MEASURE_OPTIONS = [
  { value: "deviation_count", label: "Кол-во отклонений" },
  { value: "quantity", label: "Кол-во шт" },
  { value: "amount_rub", label: "Сумма руб." },
] as const;

const CATEGORY_FILTERS = [
  { value: "По времени", label: "Время" },
  { value: "По количеству", label: "Кол-во" },
  { value: "По качеству", label: "Качество" },
] as const;

// Canonical stage order
const STAGE_ORDER: Record<string, number> = {
  "Разгрузка": 0,
  "Приемка": 1,
  "Сортировка/Размещение": 2,
  "Хранение": 3,
  "Подбор": 4,
  "Упаковка": 5,
  "Приемка ГМ": 6,
  "Отгрузка ГМ": 7,
  "Неизвестно": 99,
};

function sortValues(vals: string[], dims: string[]): string[] {
  const stageIdx = dims.indexOf("stage");
  return [...vals].sort((a, b) => {
    if (stageIdx >= 0) {
      // For composite keys "val1 | val2", extract the stage part
      const partsA = a.split(" | ");
      const partsB = b.split(" | ");
      const stageA = partsA[stageIdx] ?? a;
      const stageB = partsB[stageIdx] ?? b;
      const oa = STAGE_ORDER[stageA] ?? 50;
      const ob = STAGE_ORDER[stageB] ?? 50;
      if (oa !== ob) return oa - ob;
    }
    return a.localeCompare(b);
  });
}

// Color palette for first-level dimension values
const LEVEL_COLORS: Record<string, string> = {
  // stages
  "Приемка": "#3b82f6",
  "Подбор": "#ef4444",
  "Упаковка": "#eab308",
  "Отгрузка ГМ": "#f97316",
  "Приемка ГМ": "#fb923c",
  "Сортировка/Размещение": "#8b5cf6",
  "Разгрузка": "#0ea5e9",
  "Хранение": "#d97706",
  "Неизвестно": "#64748b",
  // deviation categories
  "По времени": "#3b82f6",
  "По количеству": "#ef4444",
  "По качеству": "#eab308",
  // warehouses
  "KDZ": "#3b82f6",
  "TSH": "#ef4444",
};
const DEFAULT_COLOR = "#64748b";

interface DataItem {
  name: string;
  value: number;
  [key: string]: unknown;
}

// Each node at an intermediate level stores its accumulated value
// and the dimension values of all its ancestors (for building parent IDs).
interface LevelEntry {
  val: number;
  dimValues: string[]; // e.g. ["EMEX", "Приемка"] for depth=2
}

function makeId(dimValues: string[]): string {
  // Unique ID = dimension values joined. Never split this to derive parents.
  return dimValues.join("|||");
}

function buildTreemap(data: DataItem[], dims: string[]) {
  const ids: string[] = ["All"];
  const labels: string[] = ["Все"];
  const parents: string[] = [""];
  const values: number[] = [0];
  const colors: string[] = ["#fff"];
  const textColors: string[] = ["#333"];

  if (dims.length === 0 || data.length === 0) {
    return { ids, labels, parents, values, colors, textColors };
  }

  // One map per depth level. Key = makeId(dimValues), value = LevelEntry
  const levels: Map<string, LevelEntry>[] = [];
  for (let i = 0; i < dims.length; i++) {
    levels.push(new Map());
  }

  // First pass: accumulate totals at every level, storing parent info explicitly
  for (const row of data) {
    const val = row.value || 0;
    if (val <= 0) continue;

    const dimValues: string[] = [];
    for (let depth = 0; depth < dims.length; depth++) {
      dimValues.push(String(row[dims[depth]] ?? "Unknown"));
      const id = makeId(dimValues);
      const existing = levels[depth].get(id);
      if (existing) {
        existing.val += val;
      } else {
        levels[depth].set(id, { val, dimValues: [...dimValues] });
      }
    }
  }

  // Second pass: add nodes level by level
  for (let depth = 0; depth < levels.length; depth++) {
    // Sort by value descending
    const entries = [...levels[depth].entries()].sort(
      (a, b) => b[1].val - a[1].val
    );

    for (const [id, entry] of entries) {
      const label = entry.dimValues[entry.dimValues.length - 1];
      // Parent is built from stored dimValues, never by splitting the id
      const parentId =
        depth === 0 ? "All" : makeId(entry.dimValues.slice(0, -1));

      ids.push(id);
      labels.push(label);
      parents.push(parentId);
      values.push(entry.val);

      // Color: first level gets mapped color, deeper levels inherit from root ancestor
      const rootLabel = entry.dimValues[0];
      if (depth === 0) {
        colors.push(LEVEL_COLORS[label] || DEFAULT_COLOR);
        textColors.push("#fff");
      } else {
        colors.push(LEVEL_COLORS[rootLabel] || DEFAULT_COLOR);
        textColors.push("#fff");
      }
    }
  }

  // Root value = sum of first-level children
  values[0] = [...levels[0].values()].reduce((sum, e) => sum + e.val, 0);

  return { ids, labels, parents, values, colors, textColors };
}

interface PivotRow {
  [key: string]: unknown;
}

const fmt = (v: number | undefined) => {
  if (v === undefined || v === null) return "";
  return new Intl.NumberFormat("ru-RU").format(v);
};

const fmtMoney = (v: number | undefined) => {
  if (v === undefined || v === null) return "";
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
};

interface DeviationsSummaryChartProps {
  colDim: string;
  globalWarehouse?: string;
  globalDateFrom?: string;
  globalDateTo?: string;
}

function DeviationsSummaryChart({ colDim, globalWarehouse, globalDateFrom, globalDateTo }: DeviationsSummaryChartProps) {
  const [data, setData] = useState<{ label: string; deviation_count: number; amount_rub: number }[]>([]);

  useEffect(() => {
    const params = new URLSearchParams({
      group_by: colDim,
      measure: "deviation_count",
    });
    if (globalWarehouse) params.set("warehouse", globalWarehouse);
    if (globalDateFrom) params.set("date_from", globalDateFrom);
    if (globalDateTo) params.set("date_to", globalDateTo);

    // Fetch both measures in parallel
    const paramsAmount = new URLSearchParams(params);
    paramsAmount.set("measure", "amount_rub");

    Promise.all([
      fetch(`/api/data?${params}`).then((r) => r.json()),
      fetch(`/api/data?${paramsAmount}`).then((r) => r.json()),
    ])
      .then(([countRows, amountRows]: [any[], any[]]) => {
        const amountMap = new Map<string, number>();
        for (const row of amountRows) {
          amountMap.set(String(row[colDim] ?? row.name ?? ""), row.value || 0);
        }
        const merged = countRows.map((row: any) => {
          const label = String(row[colDim] ?? row.name ?? "");
          return {
            label,
            deviation_count: row.value || 0,
            amount_rub: amountMap.get(label) || 0,
          };
        });
        // Sort by label (chronological for dates)
        merged.sort((a, b) => a.label.localeCompare(b.label));
        setData(merged);
      })
      .catch(console.error);
  }, [colDim, globalWarehouse, globalDateFrom, globalDateTo]);

  if (data.length === 0) return null;

  const labels = data.map((d) => d.label);
  const counts = data.map((d) => d.deviation_count);
  const amounts = data.map((d) => d.amount_rub);

  return (
    <div className="summary-chart-section">
      <Plot
        data={[
          {
            type: "bar",
            x: labels,
            y: counts,
            name: "Кол-во отклонений",
            marker: { color: "#3b82f6" },
            yaxis: "y",
          },
          {
            type: "scatter",
            mode: "lines+markers",
            x: labels,
            y: amounts,
            name: "Сумма, ₽",
            line: { color: "#ef4444", width: 2 },
            marker: { size: 5 },
            yaxis: "y2",
          },
        ]}
        layout={{
          height: 350,
          margin: { l: 60, r: 60, t: 20, b: 60 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { family: "Inter, system-ui, sans-serif" },
          xaxis: {
            title: { text: DIM_LABELS[colDim] ?? colDim },
            tickangle: labels.length > 15 ? -45 : 0,
          },
          yaxis: {
            title: { text: "Кол-во отклонений" },
            side: "left",
          },
          yaxis2: {
            title: { text: "Сумма, ₽" },
            side: "right",
            overlaying: "y",
          },
          legend: {
            orientation: "h",
            y: 1.12,
            x: 0.5,
            xanchor: "center",
          },
          bargap: 0.15,
        }}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%", borderRadius: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.1)", border: "1px solid #e0e0e0", background: "white" }}
      />
    </div>
  );
}

interface PivotTableProps {
  selectedCategories: string[];
  globalWarehouse?: string;
  globalDateFrom?: string;
  globalDateTo?: string;
  colDim: string;
  onColDimChange: (dim: string) => void;
  onCellClick?: (filters: Record<string, string>) => void;
  hasActiveFilter?: boolean;
}

function PivotTable({ selectedCategories, globalWarehouse, globalDateFrom, globalDateTo, colDim, onColDimChange, onCellClick, hasActiveFilter = false }: PivotTableProps) {
  const [rowDims, setRowDims] = useState<string[]>(["deviation_category", "deviation"]);
  const [measures, setMeasures] = useState<string[]>(["deviation_count"]);
  const [rawData, setRawData] = useState<PivotRow[]>([]);
  const [pivotLoading, setPivotLoading] = useState(false);
  
  // Detail modal state (for right-click)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalRows, setModalRows] = useState<DetailRow[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  
  // Track selected cell for visual highlight
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  
  // Clear selection when filter is cleared externally
  useEffect(() => {
    if (!hasActiveFilter) {
      setSelectedCellId(null);
    }
  }, [hasActiveFilter]);

  const toggleRowDim = (d: string) => {
    setRowDims((prev) =>
      prev.includes(d) ? (prev.length > 1 ? prev.filter((x) => x !== d) : prev) : [...prev, d]
    );
  };

  const toggleMeasure = (m: string) => {
    setMeasures((prev) =>
      prev.includes(m) ? (prev.length > 1 ? prev.filter((x) => x !== m) : prev) : [...prev, m]
    );
  };

  const ALL_MEASURES = useMemo(() => ["deviation_count", "quantity", "amount_rub"], []);
  
  useEffect(() => {
    setPivotLoading(true);
    const params = new URLSearchParams({
      row: rowDims.join(","),
      col: colDim,
      measures: ALL_MEASURES.join(","), // Always fetch all measures for tooltip
    });
    if (selectedCategories.length > 0) {
      params.set("deviation_category", selectedCategories.join(","));
    }
    if (globalWarehouse) {
      params.set("warehouse", globalWarehouse);
    }
    if (globalDateFrom) {
      params.set("date_from", globalDateFrom);
    }
    if (globalDateTo) {
      params.set("date_to", globalDateTo);
    }
    fetch(`/api/pivot?${params}`)
      .then((r) => r.json())
      .then((d: PivotRow[]) => setRawData(d))
      .catch(console.error)
      .finally(() => setPivotLoading(false));
  }, [rowDims, colDim, measures, selectedCategories, globalWarehouse, globalDateFrom, globalDateTo]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Build hierarchical pivot: tree nodes at each depth + aggregated cells
  interface TreeNode {
    key: string;       // unique path key "val1|||val2"
    label: string;     // display label (last dim value)
    depth: number;
    children: string[]; // child keys (sorted)
    cells: Record<string, Record<string, number>>; // [colVal][measure] = number
  }

  const { tree, roots, colValues } = useMemo(() => {
    const colSet = new Set<string>();
    const tree: Record<string, TreeNode> = {};

    // Accumulate leaf-level cells and build parent nodes
    for (const row of rawData) {
      const cv = String(row[colDim] ?? "");
      colSet.add(cv);

      // Build node at every depth
      const parts: string[] = [];
      for (let d = 0; d < rowDims.length; d++) {
        const val = String(row[rowDims[d]] ?? "");
        parts.push(val);
        const key = parts.join("|||");

        if (!tree[key]) {
          tree[key] = {
            key,
            label: val,
            depth: d,
            children: [],
            cells: {},
          };
          // Register as child of parent
          if (d > 0) {
            const parentKey = parts.slice(0, -1).join("|||");
            if (tree[parentKey] && !tree[parentKey].children.includes(key)) {
              tree[parentKey].children.push(key);
            }
          }
        }

        // Accumulate ALL measures at this level (for tooltip)
        if (!tree[key].cells[cv]) tree[key].cells[cv] = {};
        for (const m of ALL_MEASURES) {
          tree[key].cells[cv][m] = (tree[key].cells[cv][m] || 0) + ((row[m] as number) || 0);
        }
      }
    }

    // Collect and sort root keys
    const rootKeys = Object.keys(tree).filter((k) => tree[k].depth === 0);
    const sortedRoots = sortValues(
      rootKeys.map((k) => tree[k].label),
      [rowDims[0]]
    ).map((label) => rootKeys.find((k) => tree[k].label === label)!);

    // Sort children at every level
    for (const node of Object.values(tree)) {
      if (node.children.length > 1 && node.depth + 1 < rowDims.length) {
        const childDim = rowDims[node.depth + 1];
        const labels = node.children.map((ck) => tree[ck]?.label ?? "");
        const sorted = sortValues(labels, [childDim]);
        node.children = sorted.map(
          (lbl) => node.children.find((ck) => tree[ck]?.label === lbl)!
        );
      }
    }

    return {
      tree,
      roots: sortedRoots,
      colValues: sortValues([...colSet], [colDim]),
    };
  }, [rawData, rowDims, colDim, ALL_MEASURES]);

  // Expand all parent nodes by default when tree changes
  useEffect(() => {
    const allParentKeys = Object.keys(tree).filter(
      (k) => tree[k].depth < rowDims.length - 1
    );
    setExpanded(new Set(allParentKeys));
  }, [tree, rowDims]);

  // Flatten visible rows based on expansion state
  const visibleRows = useMemo(() => {
    const result: { key: string; node: TreeNode }[] = [];
    const walk = (keys: string[]) => {
      for (const key of keys) {
        const node = tree[key];
        if (!node) continue;
        result.push({ key, node });
        const isLeaf = node.depth === rowDims.length - 1;
        if (!isLeaf && expanded.has(key)) {
          walk(node.children);
        }
      }
    };
    walk(roots);
    return result;
  }, [tree, roots, expanded, rowDims]);

  return (
    <div className="pivot-section">
      <h2>Сводная таблица</h2>

      <div className="pivot-layout">
        <div className="pivot-table-area">
          <DeviationsSummaryChart
            colDim={colDim}
            globalWarehouse={globalWarehouse}
            globalDateFrom={globalDateFrom}
            globalDateTo={globalDateTo}
          />
          {pivotLoading ? (
            <p className="loading">Загрузка...</p>
          ) : (
            <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th className="row-header">{rowDims.map((d) => DIM_LABELS[d] ?? d).join(" → ")} \ {DIM_LABELS[colDim] ?? colDim}</th>
                {colValues.map((cv) => {
                  const colHeaderId = `col|||${cv}`;
                  const isColSelected = selectedCellId === colHeaderId;
                  const handleColClick = () => {
                    if (!onCellClick) return;
                    const filters: Record<string, string> = { [colDim]: cv };
                    setSelectedCellId(colHeaderId);
                    onCellClick(filters);
                  };
                  return (
                    <th
                      key={cv}
                      colSpan={measures.length}
                      className={`col-header clickable ${isColSelected ? "selected" : ""}`}
                      onClick={handleColClick}
                    >
                      {cv}
                    </th>
                  );
                })}
              </tr>
              {measures.length > 1 && (
                <tr>
                  <th></th>
                  {colValues.map((cv) =>
                    measures.map((m) => {
                      const label = MEASURE_OPTIONS.find((o) => o.value === m)?.label ?? m;
                      return <th key={`${cv}-${m}`} className="measure-header">{label}</th>;
                    })
                  )}
                </tr>
              )}
            </thead>
            <tbody>
              {visibleRows.map(({ key, node }) => {
                const isLeaf = node.depth === rowDims.length - 1;
                const isOpen = expanded.has(key);
                const hasChildren = node.children.length > 0 && !isLeaf;
                return (
                  <tr key={key} className={node.depth === 0 ? "parent-row" : ""}>
                    <td
                      className={`row-label ${hasChildren ? "expandable" : ""}`}
                      style={{ paddingLeft: `${12 + node.depth * 20}px` }}
                      onClick={() => hasChildren && toggleExpand(key)}
                    >
                      {hasChildren && (
                        <span className="expand-icon">{isOpen ? "▼" : "▶"}</span>
                      )}
                      {node.label}
                    </td>
                    {colValues.map((cv) =>
                      measures.map((m) => {
                        const val = node.cells[cv]?.[m];
                        const cellData = node.cells[cv];
                        const tooltipText = cellData
                          ? `Кол-во откл.: ${fmt(cellData.deviation_count || 0)}\nКол-во шт: ${fmt(cellData.quantity || 0)}\nСумма: ${fmtMoney(cellData.amount_rub || 0)} ₽`
                          : "";
                        
                        const cellId = `${key}|||${cv}|||${m}`;
                        const isSelected = selectedCellId === cellId || selectedCellId === `col|||${cv}`;
                        
                        const handleCellClick = () => {
                          if (!val || !onCellClick) return;
                          const filters: Record<string, string> = {};
                          const parts = key.split("|||");
                          parts.forEach((v, i) => {
                            if (rowDims[i]) filters[rowDims[i]] = v;
                          });
                          filters[colDim] = cv;
                          setSelectedCellId(cellId);
                          onCellClick(filters);
                        };
                        
                        const handleCellRightClick = (e: React.MouseEvent) => {
                          e.preventDefault();
                          if (!val) return;
                          const filters: Record<string, string> = {};
                          const parts = key.split("|||");
                          parts.forEach((v, i) => {
                            if (rowDims[i]) filters[rowDims[i]] = v;
                          });
                          filters[colDim] = cv;
                          if (globalWarehouse) filters.warehouse = globalWarehouse;
                          if (globalDateFrom) filters.date_from = globalDateFrom;
                          if (globalDateTo) filters.date_to = globalDateTo;
                          
                          const labelParts = [...parts, cv];
                          setModalTitle(labelParts.join(" / "));
                          setModalRows([]);
                          setModalOpen(true);
                          setModalLoading(true);
                          
                          const params = new URLSearchParams(filters);
                          fetch(`/api/data/rows?${params}`)
                            .then((r) => r.json())
                            .then((rows: DetailRow[]) => setModalRows(rows))
                            .catch(console.error)
                            .finally(() => setModalLoading(false));
                        };
                        
                        return (
                          <td
                            key={`${cv}-${m}`}
                            className={`cell ${val ? "clickable" : ""} ${isSelected ? "selected" : ""}`}
                            title={tooltipText}
                            onClick={handleCellClick}
                            onContextMenu={handleCellRightClick}
                          >
                            {val ? (m === "amount_rub" ? fmtMoney(val) : fmt(val)) : ""}
                          </td>
                        );
                      })
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
            </div>
          )}
        </div>

        <aside className="pivot-sidebar">
          <section className="filter-section">
            <h3>Строки</h3>
            {FILTER_SECTIONS.filter((sec) => sec.title !== "Время").map((sec) => (
              <fieldset key={sec.title}>
                <legend>{sec.title}</legend>
                <div className="chips">
                  {sec.dims.map((d) => (
                    <button
                      key={d}
                      className={`chip ${rowDims.includes(d) ? "active" : ""}`}
                      onClick={() => toggleRowDim(d)}
                    >
                      {DIM_LABELS[d] ?? d}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </section>

          <section className="filter-section">
            <h3>Столбцы</h3>
            <select value={colDim} onChange={(e) => onColDimChange(e.target.value)}>
              {DIMENSION_OPTIONS.map((d) => (
                <option key={d} value={d}>{DIM_LABELS[d] ?? d}</option>
              ))}
            </select>
          </section>

          <section className="filter-section">
            <h3>Значения</h3>
            <div className="chips">
              {([
                ["deviation_count", "Отклонения"],
                ["quantity", "Кол-во шт"],
                ["amount_rub", "Сумма ₽"],
              ] as const).map(([m, label]) => (
                <button
                  key={m}
                  className={`chip ${measures.includes(m) ? "active" : ""}`}
                  onClick={() => toggleMeasure(m)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

        </aside>
      </div>

      <DetailModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={modalTitle}
        rows={modalRows}
        loading={modalLoading}
      />
    </div>
  );
}

interface TreemapSectionProps {
  title: string;
  filterSections: typeof FILTER_SECTIONS;
  measureOptions: typeof MEASURE_OPTIONS;
  defaultDims?: string[];
  defaultMeasure?: string;
  fixedCategories?: string[];  // If set, category filter is hidden and these are used
  showCategoryFilter?: boolean;
  globalWarehouse?: string;
  globalDateFrom?: string;
  globalDateTo?: string;
  pivotFilters?: Record<string, string>;
}

interface DetailRow {
  datetime: string;
  day: string;
  week: string;
  hour: number;
  shift: string;
  stage: string;
  deviation_category: string;
  deviation: string;
  warehouse: string;
  customer: string;
  deviation_count: number;
  quantity: number;
  amount_rub: number;
  employee: string;
  product_name: string;
  item_type: string;
}

interface DetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  rows: DetailRow[];
  loading: boolean;
}

const DETAIL_COLUMNS: { key: keyof DetailRow; label: string }[] = [
  { key: "datetime", label: "Дата/Время" },
  { key: "warehouse", label: "Склад" },
  { key: "stage", label: "Этап" },
  { key: "deviation", label: "Отклонение" },
  { key: "deviation_count", label: "Кол-во откл." },
  { key: "quantity", label: "Ед." },
  { key: "amount_rub", label: "Сумма, ₽" },
  { key: "employee", label: "Сотрудник" },
  { key: "product_name", label: "Наименование" },
  { key: "item_type", label: "Тип товара" },
];

function DetailModal({ isOpen, onClose, title, rows, loading }: DetailModalProps) {
  const [sortCol, setSortCol] = useState<keyof DetailRow | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (col: keyof DetailRow) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  if (!isOpen) return null;
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {loading && <p className="loading">Загрузка...</p>}
          {!loading && rows.length === 0 && <p>Нет данных</p>}
          {!loading && rows.length > 0 && (
            <table className="detail-table">
              <thead>
                <tr>
                  {DETAIL_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className="sortable-th"
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                      {sortCol === col.key && (
                        <span className="sort-arrow">{sortDir === "asc" ? " ▲" : " ▼"}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.datetime}</td>
                    <td>{row.warehouse}</td>
                    <td>{row.stage}</td>
                    <td>{row.deviation}</td>
                    <td>{row.deviation_count}</td>
                    <td>{row.quantity}</td>
                    <td>{row.amount_rub != null ? fmtMoney(Number(row.amount_rub)) : ""}</td>
                    <td>{row.employee}</td>
                    <td>{row.product_name}</td>
                    <td>{row.item_type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && rows.length === 500 && (
            <p className="limit-note">Показаны первые 500 записей</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TreemapSection({
  title,
  filterSections,
  measureOptions,
  defaultDims = ["stage"],
  defaultMeasure = "deviation_count",
  fixedCategories,
  showCategoryFilter = true,
  globalWarehouse,
  globalDateFrom,
  globalDateTo,
  pivotFilters = {},
}: TreemapSectionProps) {
  const [selectedDims, setSelectedDims] = useState<string[]>(defaultDims);
  const [measure, setMeasure] = useState(defaultMeasure);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(fixedCategories || []);
  const [selectedDeviations, setSelectedDeviations] = useState<string[]>([]);
  const [deviationOptions, setDeviationOptions] = useState<string[]>([]);
  const [data, setData] = useState<DataItem[]>([]);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    fetch("/api/dimensions")
      .then((r) => r.json())
      .then((dims: Record<string, string[]>) => {
        const devs = dims.deviation?.filter((d) => d && d !== "Не определено") || [];
        setDeviationOptions(devs);
      })
      .catch(console.error);
  }, []);
  
  // Detail modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalRows, setModalRows] = useState<DetailRow[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  

  useEffect(() => {
    if (selectedDims.length === 0) return;
    setLoading(true);
    // Map time_qty to quantity for API
    const apiMeasure = measure === "time_qty" ? "quantity" : measure;
    const params = new URLSearchParams({
      group_by: selectedDims.join(","),
      measure: apiMeasure,
    });
    const cats = fixedCategories || selectedCategories;
    if (cats.length > 0) {
      params.set("deviation_category", cats.join(","));
    }
    if (selectedDeviations.length > 0) {
      params.set("deviation", selectedDeviations.join(","));
    }
    if (globalWarehouse) {
      params.set("warehouse", globalWarehouse);
    }
    // Add pivot table filters
    for (const [key, value] of Object.entries(pivotFilters)) {
      if (value && !params.has(key)) {
        params.set(key, value);
      }
    }
    if (globalDateFrom) params.set("date_from", globalDateFrom);
    if (globalDateTo) params.set("date_to", globalDateTo);
    fetch(`/api/data?${params}`)
      .then((r) => r.json())
      .then((d: DataItem[]) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedDims, measure, selectedCategories, fixedCategories, selectedDeviations, globalWarehouse, pivotFilters, globalDateFrom, globalDateTo]);

  const treemap = useMemo(
    () => buildTreemap(data, selectedDims),
    [data, selectedDims]
  );

  const currentMeasure = measureOptions.find((m) => m.value === measure);
  const unit = measure === "amount_rub" ? "₽" : "";
  const textTemplate =
    unit === "₽"
      ? "%{label}<br><b>%{value:,.0f}₽</b>"
      : "%{label}<br><b>%{value:,.0f}</b>";
  const hoverTemplate =
    unit === "₽"
      ? `<b>%{label}</b><br>${currentMeasure?.label}: %{value:,.0f}₽<extra></extra>`
      : `<b>%{label}</b><br>${currentMeasure?.label}: %{value:,.0f}<extra></extra>`;

  const toggleDim = (dim: string) => {
    setSelectedDims((prev) =>
      prev.includes(dim) ? prev.filter((d) => d !== dim) : [...prev, dim]
    );
  };

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const toggleDeviation = (dev: string) => {
    setSelectedDeviations((prev) =>
      prev.includes(dev) ? prev.filter((d) => d !== dev) : [...prev, dev]
    );
  };

  // Build a set of leaf node IDs for quick lookup (using same separator as makeId: "|||")
  const leafNodeIds = useMemo(() => {
    const leaves = new Set<string>();
    if (selectedDims.length === 0) return leaves;
    
    // Leaf nodes are at the deepest level (selectedDims.length parts)
    for (const row of data) {
      const parts: string[] = [];
      for (const dim of selectedDims) {
        parts.push(String(row[dim] ?? "Unknown"));
      }
      leaves.add(parts.join("|||"));
    }
    return leaves;
  }, [data, selectedDims]);

  // Find the treemap point from a native DOM event by walking up the target's __data__
  const getPointFromEvent = (e: MouseEvent): {id: string, label: string} | null => {
    let target = e.target as any;
    while (target && target !== e.currentTarget) {
      const data = target.__data__;
      if (data) {
        // Plotly treemap stores data differently depending on version
        const pointId = data.id ?? data.data?.id;
        const pointLabel = data.label ?? data.data?.label;
        if (pointId && leafNodeIds.has(pointId)) {
          return { id: pointId, label: pointLabel || pointId };
        }
      }
      target = target.parentNode;
    }
    return null;
  };

  // Attach native contextmenu listener to Plotly's container for reliable right-click
  const chartContainerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;
    
    const handler = (e: MouseEvent) => {
      const point = getPointFromEvent(e);
      if (!point) return;
      
      e.preventDefault();
      
      const { id, label } = point;
      const parts = id.split("|||").filter(Boolean);
      
      setModalRows([]);
      setModalTitle(label);
      setModalOpen(true);
      setModalLoading(true);
      
      const params = new URLSearchParams();
      parts.forEach((value, idx) => {
        if (selectedDims[idx] && value) {
          params.set(selectedDims[idx], value);
        }
      });
      
      const cats = fixedCategories || selectedCategories;
      if (cats.length > 0) {
        params.set("deviation_category", cats[0]);
      }
      if (selectedDeviations.length > 0) {
        params.set("deviation", selectedDeviations[0]);
      }
      if (globalWarehouse) {
        params.set("warehouse", globalWarehouse);
      }
      for (const [key, value] of Object.entries(pivotFilters)) {
        if (value && !params.has(key)) {
          params.set(key, value);
        }
      }
      if (globalDateFrom) params.set("date_from", globalDateFrom);
      if (globalDateTo) params.set("date_to", globalDateTo);
      
      console.log("[RIGHT-CLICK] fetching /api/data/rows with params:", Object.fromEntries(params.entries()));
      fetch(`/api/data/rows?${params}`)
        .then((r) => r.json())
        .then((rows: DetailRow[]) => {
          console.log("[RIGHT-CLICK] got", rows.length, "rows");
          setModalRows(rows);
        })
        .catch((err) => {
          console.error("Failed to fetch rows:", err);
          setModalRows([]);
        })
        .finally(() => setModalLoading(false));
    };
    
    container.addEventListener("contextmenu", handler);
    return () => container.removeEventListener("contextmenu", handler);
  }); // intentionally no deps — always uses latest closure values

  return (
    <div className="treemap-section">
      <h2>{title}</h2>

      <div className="chart-and-filters">
        <div className="chart-area">
          {loading && <p className="loading">Загрузка...</p>}

          {!loading && data.length > 0 && (
            <div className="chart-container" ref={chartContainerRef}>
              <Plot
                key={selectedDims.join(",") + measure}
                data={[
                  {
                    type: "treemap",
                    ids: treemap.ids,
                    labels: treemap.labels,
                    parents: treemap.parents,
                    values: treemap.values,
                    branchvalues: "total",
                    textinfo: "label+value",
                    texttemplate: textTemplate,
                    textfont: {
                      family: "Inter, system-ui, sans-serif",
                      color: treemap.textColors,
                    },
                    hovertemplate: hoverTemplate,
                    hoverlabel: {
                      bgcolor: "#1e293b",
                      bordercolor: "transparent",
                      font: { color: "#fff", size: 13 },
                    },
                    marker: {
                      colors: treemap.colors,
                      line: { width: 1, color: "rgba(255,255,255,0.5)" },
                      pad: { t: 25, l: 5, r: 5, b: 5 },
                    },
                    pathbar: {
                      visible: true,
                      thickness: 24,
                      textfont: { size: 12, color: "#fff" },
                      edgeshape: ">",
                    },
                    tiling: {
                      packing: "squarify",
                      pad: 3,
                    },
                  } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                ]}
                layout={{
                  margin: { l: 0, r: 0, t: 30, b: 0 },
                  height: 700,
                  paper_bgcolor: "transparent",
                  font: { family: "Inter, system-ui, sans-serif" },
                }}
                config={{
                  displayModeBar: false,
                  responsive: true,
                }}
                style={{
                  width: "100%",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                  border: "1px solid #e0e0e0",
                }}
              />
              <p className="context-hint">Правый клик на ячейке нижнего уровня — показать детали</p>
            </div>
          )}
        </div>

        <DetailModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          title={modalTitle}
          rows={modalRows}
          loading={modalLoading}
        />

        <aside className="filters-sidebar">
          <section className="filter-section">
            <h3>Разрезы</h3>
            {filterSections.map((sec) => (
              <fieldset key={sec.title}>
                <legend>{sec.title}</legend>
                <div className="chips">
                  {sec.dims.map((dim) => (
                    <button
                      key={dim}
                      className={`chip ${selectedDims.includes(dim) ? "active" : ""}`}
                      onClick={() => toggleDim(dim)}
                    >
                      {DIM_LABELS[dim] ?? dim}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </section>

          <section className="filter-section">
            <h3>Метрика</h3>
            <select value={measure} onChange={(e) => setMeasure(e.target.value)}>
              {measureOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </section>

          {showCategoryFilter && !fixedCategories && (
            <section className="filter-section">
              <h3>Тип отклонения</h3>
              <div className="chips">
                {CATEGORY_FILTERS.map((cat) => (
                  <button
                    key={cat.value}
                    className={`chip ${selectedCategories.includes(cat.value) ? "active" : ""}`}
                    onClick={() => toggleCategory(cat.value)}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
              {selectedCategories.length > 0 && (
                <button className="chip reset" onClick={() => setSelectedCategories([])}>
                  сбросить
                </button>
              )}
            </section>
          )}

          <section className="filter-section">
            <h3>Подтип отклонения</h3>
            <div className="chips">
              {deviationOptions.map((dev) => (
                <button
                  key={dev}
                  className={`chip ${selectedDeviations.includes(dev) ? "active" : ""}`}
                  onClick={() => toggleDeviation(dev)}
                >
                  {dev}
                </button>
              ))}
            </div>
            {selectedDeviations.length > 0 && (
              <button className="chip reset" onClick={() => setSelectedDeviations([])}>
                сбросить
              </button>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

// ---- Times Treemap (from times.tsv) ----
const TIMES_DIMENSION_OPTIONS = [
  "stage",
  "item_type",
  "warehouse",
  "employee",
] as const;

const TIMES_DIM_LABELS: Record<string, string> = {
  stage: "Этап",
  parent_type: "Этап (сырой)",
  item_type: "Тип товара",
  warehouse: "Терминал",
  employee: "Сотрудник",
};

const TIMES_FILTER_SECTIONS: { title: string; dims: readonly (typeof TIMES_DIMENSION_OPTIONS)[number][] }[] = [
  { title: "Операции", dims: ["stage", "item_type"] },
  { title: "Организация", dims: ["warehouse", "employee"] },
];

const TIMES_MEASURE_OPTIONS = [
  { value: "time420", label: "Время всего, ч" },
  { value: "time_spent", label: "Время работы, ч" },
  { value: "productivity_loss_h", label: "Потери производительности, ч" },
  { value: "idle_loss_h", label: "Простои, ч" },
  { value: "ops", label: "Операции" },
] as const;

// Linear color gradient for productivity * utilization
// Scale shifted: 0% = red, 65% = yellow, 85%+ = green (stricter gradient)
function prodUtilToColor(prodUtil: number): string {
  // prodUtil: 0-1 (but values are 0-100 from API, so we use as-is if >1)
  const raw = prodUtil > 1 ? prodUtil / 100 : prodUtil;
  // Shift the gradient: compress the scale so green requires higher values
  // Map 0-0.85 to 0-1 for color calculation (values above 0.85 are full green)
  const p = Math.max(0, Math.min(1, raw / 0.85));
  
  // Linear interpolation: red (0) -> yellow (0.65/0.85 ≈ 0.76) -> green (1)
  const yellowPoint = 0.65 / 0.85; // ~0.76 in normalized scale
  
  let r: number, g: number, b: number;
  
  if (p <= yellowPoint) {
    // Red to Yellow: 0 -> yellowPoint
    const t = p / yellowPoint; // 0 to 1
    r = 239;                              // stays red
    g = Math.round(68 + t * (179 - 68));  // 68 -> 179
    b = Math.round(68 - t * 60);          // 68 -> 8
  } else {
    // Yellow to Green: yellowPoint -> 1
    const t = (p - yellowPoint) / (1 - yellowPoint); // 0 to 1
    r = Math.round(234 - t * 200);        // 234 -> 34
    g = Math.round(179 + t * 18);         // 179 -> 197
    b = Math.round(8 + t * 86);           // 8 -> 94
  }
  
  return `rgb(${r},${g},${b})`;
}

interface TimesDataItem extends DataItem {
  prodUtil?: number;
  productivity?: number;
  utilization?: number;
  delays?: number;
  // Raw totals for proper aggregation
  totalNorm?: number;
  totalTimeSpent?: number;
  totalTime420?: number;
  weightedPctNorm?: number;
  totalOps?: number;
}

interface TimesLevelEntry {
  val: number;
  dimValues: string[];
  // Raw totals for correct aggregation
  totalNorm: number;
  totalTimeSpent: number;
  totalTime420: number;
  weightedPctNorm: number;
  totalOps: number;
}

function TimesTreemapSection() {
  const [selectedDims, setSelectedDims] = useState<string[]>(["warehouse", "stage", "employee"]);
  const [measure, setMeasure] = useState("time420");
  const [data, setData] = useState<TimesDataItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selectedDims.length === 0) return;
    setLoading(true);
    const params = new URLSearchParams({
      group_by: selectedDims.join(","),
      measure,
    });
    fetch(`/api/times/data?${params}`)
      .then((r) => r.json())
      .then((d: TimesDataItem[]) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedDims, measure]);

  // Build treemap with utilization-based colors
  const treemap = useMemo(() => {
    const ids: string[] = ["All"];
    const labels: string[] = ["Все"];
    const parents: string[] = [""];
    const values: number[] = [0];
    const colors: string[] = ["#e5e7eb"];  // neutral gray for root
    const textColors: string[] = ["#333"];
    const customdata: [number, number, number][] = [[0, 0, 0]];  // [productivity, utilization, delays]

    if (selectedDims.length === 0 || data.length === 0) {
      return { ids, labels, parents, values, colors, textColors, customdata };
    }

    // Extended entry type with productivity/utilization tracking
    const levels: Map<string, TimesLevelEntry>[] = [];
    for (let i = 0; i < selectedDims.length; i++) {
      levels.push(new Map());
    }

    for (const row of data) {
      const val = row.value || 0;
      if (val <= 0) continue;
      
      // Use raw totals for proper aggregation
      const rowTotalNorm = row.totalNorm ?? 0;
      const rowTotalTimeSpent = row.totalTimeSpent ?? 0;
      const rowTotalTime420 = row.totalTime420 ?? 0;
      const rowWeightedPctNorm = row.weightedPctNorm ?? 0;
      const rowTotalOps = row.totalOps ?? 0;

      const dimValues: string[] = [];
      for (let depth = 0; depth < selectedDims.length; depth++) {
        dimValues.push(String(row[selectedDims[depth]] ?? "Unknown"));
        const id = makeId(dimValues);
        const existing = levels[depth].get(id);
        if (existing) {
          existing.val += val;
          existing.totalNorm += rowTotalNorm;
          existing.totalTimeSpent += rowTotalTimeSpent;
          existing.totalTime420 += rowTotalTime420;
          existing.weightedPctNorm += rowWeightedPctNorm;
          existing.totalOps += rowTotalOps;
        } else {
          levels[depth].set(id, {
            val,
            dimValues: [...dimValues],
            totalNorm: rowTotalNorm,
            totalTimeSpent: rowTotalTimeSpent,
            totalTime420: rowTotalTime420,
            weightedPctNorm: rowWeightedPctNorm,
            totalOps: rowTotalOps,
          });
        }
      }
    }

    for (let depth = 0; depth < levels.length; depth++) {
      const entries = [...levels[depth].entries()].sort(
        (a, b) => b[1].val - a[1].val
      );

      for (const [id, entry] of entries) {
        const label = entry.dimValues[entry.dimValues.length - 1];
        const parentId =
          depth === 0 ? "All" : makeId(entry.dimValues.slice(0, -1));

        ids.push(id);
        labels.push(label);
        parents.push(parentId);
        values.push(entry.val);

        // Calculate from aggregated raw totals
        const avgProductivity = entry.totalTimeSpent > 0
          ? Math.min(100, (entry.totalNorm / entry.totalTimeSpent) * 100)
          : 0;
        const avgUtilization = entry.totalTime420 > 0
          ? Math.min(100, (entry.totalTimeSpent / entry.totalTime420) * 100)
          : 0;
        const avgDelays = entry.totalOps > 0
          ? 100 - (entry.weightedPctNorm / entry.totalOps)
          : 0;
        // Color based on productivity * utilization (0-100 each -> 0-1)
        const prodUtilForColor = (avgProductivity * avgUtilization) / 10000;
        
        colors.push(prodUtilToColor(prodUtilForColor));
        textColors.push("#fff");
        customdata.push([avgProductivity, avgUtilization, avgDelays]);
      }
    }

    values[0] = [...levels[0].values()].reduce((sum, e) => sum + e.val, 0);

    return { ids, labels, parents, values, colors, textColors, customdata };
  }, [data, selectedDims]);

  const currentMeasure = TIMES_MEASURE_OPTIONS.find((m) => m.value === measure);
  const textTemplate = "%{label}<br><b>%{value:,.1f}</b>";
  const hoverTemplate = `<b>%{label}</b><br>${currentMeasure?.label}: %{value:,.2f}<br>Производительность: %{customdata[0]:.1f}%<br>Утилизация: %{customdata[1]:.1f}%<br>Опоздания: %{customdata[2]:.1f}%<extra></extra>`;

  const toggleDim = (dim: string) => {
    setSelectedDims((prev) =>
      prev.includes(dim) ? prev.filter((d) => d !== dim) : [...prev, dim]
    );
  };

  return (
    <div className="treemap-section">
      <h2>Временной срез, 1-16 февраля</h2>

      <div className="chart-and-filters">
        <div className="chart-area">
          {loading && <p className="loading">Загрузка...</p>}

          {!loading && data.length > 0 && (
            <div className="chart-container">
              <Plot
                key={selectedDims.join(",") + measure}
                data={[
                  {
                    type: "treemap",
                    ids: treemap.ids,
                    labels: treemap.labels,
                    parents: treemap.parents,
                    values: treemap.values,
                    customdata: treemap.customdata,
                    branchvalues: "total",
                    textinfo: "label+value",
                    texttemplate: textTemplate,
                    textfont: {
                      family: "Inter, system-ui, sans-serif",
                      color: treemap.textColors,
                    },
                    hovertemplate: hoverTemplate,
                    hoverlabel: {
                      bgcolor: "#1e293b",
                      bordercolor: "transparent",
                      font: { color: "#fff", size: 13 },
                    },
                    marker: {
                      colors: treemap.colors,
                      line: { width: 1, color: "rgba(255,255,255,0.5)" },
                      pad: { t: 25, l: 5, r: 5, b: 5 },
                    },
                    pathbar: {
                      visible: true,
                      thickness: 24,
                      textfont: { size: 12, color: "#fff" },
                      edgeshape: ">",
                    },
                    tiling: {
                      packing: "squarify",
                      pad: 3,
                    },
                  } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                ]}
                layout={{
                  margin: { l: 0, r: 0, t: 30, b: 0 },
                  height: 700,
                  paper_bgcolor: "transparent",
                  font: { family: "Inter, system-ui, sans-serif" },
                }}
                config={{
                  displayModeBar: false,
                  responsive: true,
                }}
                style={{
                  width: "100%",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                  border: "1px solid #e0e0e0",
                }}
              />
            </div>
          )}
        </div>

        <aside className="filters-sidebar">
          <section className="filter-section">
            <h3>Разрезы</h3>
            {TIMES_FILTER_SECTIONS.map((sec) => (
              <fieldset key={sec.title}>
                <legend>{sec.title}</legend>
                <div className="chips">
                  {sec.dims.map((dim) => (
                    <button
                      key={dim}
                      className={`chip ${selectedDims.includes(dim) ? "active" : ""}`}
                      onClick={() => toggleDim(dim)}
                    >
                      {TIMES_DIM_LABELS[dim] ?? dim}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </section>

          <section className="filter-section">
            <h3>Метрика</h3>
            <select value={measure} onChange={(e) => setMeasure(e.target.value)}>
              {TIMES_MEASURE_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </section>
        </aside>
      </div>
    </div>
  );
}

// ---- Stacked Bar Chart ----
interface StackedBarData {
  parentType: string;
  parentTypeLabel: string;
  opType: string;
  opTypeLabel: string;
  value: number;
  delays: number;
  order: number;
}

function StackedBarChart() {
  const [data, setData] = useState<StackedBarData[]>([]);
  const [loading, setLoading] = useState(false);
  const [warehouse, setWarehouse] = useState<string>("DWC");
  const [warehouses, setWarehouses] = useState<string[]>([]);

  // Fetch available warehouses
  useEffect(() => {
    fetch("/api/times/data?group_by=warehouse")
      .then((r) => r.json())
      .then((d: { warehouse: string }[]) => {
        const whs = d.map((r) => r.warehouse).filter(Boolean).sort();
        setWarehouses(whs);
      })
      .catch(console.error);
  }, []);

  // Fetch stacked bar data
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (warehouse) params.set("warehouse", warehouse);
    
    fetch(`/api/times/stacked?${params}`)
      .then((r) => r.json())
      .then((d: StackedBarData[]) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [warehouse]);

  // Build stacked bar traces
  const traces = useMemo(() => {
    if (data.length === 0) return [];

    // Get unique parent types (stages) sorted by order
    const parentTypes = [...new Set(data.map((d) => d.parentType))]
      .map((pt) => {
        const item = data.find((d) => d.parentType === pt);
        return { parentType: pt, label: item?.parentTypeLabel || pt, order: item?.order || 99 };
      })
      .sort((a, b) => a.order - b.order);

    // Get unique op types
    const opTypes = [...new Set(data.map((d) => d.opType))];

    // Color function: low delays = bright green, high delays = bright red (lighter colors for black text)
    const delaysToColor = (delays: number): string => {
      // delays 0% = bright green, 50%+ = bright red
      const p = Math.min(1, Math.max(0, delays / 50));
      if (p < 0.5) {
        // Bright green to bright yellow (0-25% delays)
        const t = p * 2;
        const r = Math.round(134 + (255 - 134) * t);
        const g = Math.round(239 + (230 - 239) * t);
        const b = Math.round(172 + (120 - 172) * t);
        return `rgb(${r}, ${g}, ${b})`;
      } else {
        // Bright yellow to bright red (25-50%+ delays)
        const t = (p - 0.5) * 2;
        const r = Math.round(255 + (255 - 255) * t);
        const g = Math.round(230 + (150 - 230) * t);
        const b = Math.round(120 + (150 - 120) * t);
        return `rgb(${r}, ${g}, ${b})`;
      }
    };

    // Minimum bar height for visibility (in chart units)
    const MIN_BAR_HEIGHT = 40;

    return opTypes.map((opType) => {
      const opLabel = data.find((d) => d.opType === opType)?.opTypeLabel || opType;
      const xValues = parentTypes.map((pt) => pt.label);
      const yValues: number[] = [];
      const colorValues: string[] = [];
      const customData: [number, number][] = [];

      parentTypes.forEach((pt) => {
        const item = data.find((d) => d.parentType === pt.parentType && d.opType === opType);
        const val = item?.value || 0;
        const delays = item?.delays || 0;
        // Use minimum height for display, keep actual value for tooltip
        yValues.push(val > 0 ? Math.max(val, MIN_BAR_HEIGHT) : 0);
        customData.push([val, delays]);
        colorValues.push(delaysToColor(delays));
      });

      return {
        name: opLabel,
        type: "bar" as const,
        x: xValues,
        y: yValues,
        text: xValues.map(() => opLabel),
        textposition: "inside" as const,
        textfont: { color: "#000", size: 10, family: "Inter, system-ui, sans-serif" },
        insidetextanchor: "middle" as const,
        marker: { color: colorValues },
        customdata: customData,
        hovertemplate: `<b>${opLabel}</b><br>Ср время: %{customdata[0]:.0f} сек<br>Опоздания: %{customdata[1]:.1f}%<extra></extra>`,
      };
    });
  }, [data]);

  return (
    <div className="treemap-section">
      <h2>Время цикла и опоздания</h2>

      <div className="chart-and-filters">
        <div className="chart-area">
          {loading && <p className="loading">Загрузка...</p>}

          {!loading && data.length > 0 && (
            <div className="chart-container">
              <Plot
                data={traces}
                layout={{
                  margin: { l: 60, r: 40, t: 40, b: 100 },
                  height: 800,
                  barmode: "stack",
                  bargap: 0.1,
                  paper_bgcolor: "transparent",
                  plot_bgcolor: "transparent",
                  font: { family: "Inter, system-ui, sans-serif" },
                  xaxis: {
                    tickangle: -45,
                    tickfont: { size: 11 },
                  },
                  yaxis: {
                    title: { text: "Ср время (сек)" },
                    gridcolor: "#e5e7eb",
                  },
                  legend: {
                    orientation: "h",
                    y: -0.3,
                  },
                }}
                config={{
                  displayModeBar: false,
                  responsive: true,
                }}
                style={{
                  width: "100%",
                  borderRadius: "12px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                  border: "1px solid #e0e0e0",
                  background: "#fff",
                }}
              />
            </div>
          )}
        </div>

        <aside className="filters-sidebar">
          <section className="filter-section">
            <h3>Терминал</h3>
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="">Все</option>
              {warehouses.map((wh) => (
                <option key={wh} value={wh}>{wh}</option>
              ))}
            </select>
          </section>
        </aside>
      </div>
    </div>
  );
}

function getDefaultDateRange() {
  const today = new Date();
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  return {
    from: threeMonthsAgo.toISOString().split("T")[0],
    to: today.toISOString().split("T")[0],
  };
}

function App() {
  const [selectedCategories] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState<"deviations" | "times">("deviations");
  
  const [warehouseOptions, setWarehouseOptions] = useState<string[]>([]);
  const [pivotFilters, setPivotFilters] = useState<Record<string, string>>({});
  const [colDim, setColDim] = useState("week");
  
  const defaultDates = getDefaultDateRange();
  const savedWh = localStorage.getItem("globalWarehouse") || "";

  // Applied (committed) filter values — these drive all data fetches
  const [globalDateFrom, setGlobalDateFrom] = useState(defaultDates.from);
  const [globalDateTo, setGlobalDateTo] = useState(defaultDates.to);
  const [globalWarehouse, setGlobalWarehouse] = useState(savedWh);

  // Draft filter values — user edits these, applied on button click
  const [draftDateFrom, setDraftDateFrom] = useState(defaultDates.from);
  const [draftDateTo, setDraftDateTo] = useState(defaultDates.to);
  const [draftWarehouse, setDraftWarehouse] = useState(savedWh);

  const filtersChanged = draftDateFrom !== globalDateFrom || draftDateTo !== globalDateTo || draftWarehouse !== globalWarehouse;

  const applyFilters = () => {
    setGlobalDateFrom(draftDateFrom);
    setGlobalDateTo(draftDateTo);
    setGlobalWarehouse(draftWarehouse);
    localStorage.setItem("globalWarehouse", draftWarehouse);
  };

  useEffect(() => {
    fetch("/api/dimensions")
      .then((r) => r.json())
      .then((dims: Record<string, string[]>) => {
        const whs = dims.warehouse?.filter((w) => w) || [];
        setWarehouseOptions(whs);
      })
      .catch(console.error);
  }, []);

  const handlePivotCellClick = (filters: Record<string, string>) => {
    setPivotFilters(filters);
  };

  return (
    <div className="app">
      <div className="global-filters">
        <nav className="page-nav">
          <button
            className={`nav-tab ${currentPage === "deviations" ? "active" : ""}`}
            onClick={() => setCurrentPage("deviations")}
          >
            Отклонения
          </button>
          <button
            className={`nav-tab ${currentPage === "times" ? "active" : ""}`}
            onClick={() => setCurrentPage("times")}
          >
            Время
          </button>
        </nav>

        <div className="global-filters-right">
          <div className="global-date-filter">
            <label>Период:</label>
            <input
              type="date"
              value={draftDateFrom}
              onChange={(e) => setDraftDateFrom(e.target.value)}
            />
            <span className="date-separator">—</span>
            <input
              type="date"
              value={draftDateTo}
              onChange={(e) => setDraftDateTo(e.target.value)}
            />
          </div>
          
          <div className="global-warehouse-filter">
            <label>Терминал:</label>
            <select value={draftWarehouse} onChange={(e) => setDraftWarehouse(e.target.value)}>
              <option value="">Все</option>
              {warehouseOptions.map((wh) => (
                <option key={wh} value={wh}>{wh}</option>
              ))}
            </select>
          </div>

          <button
            className={`apply-filters-btn${filtersChanged ? " changed" : ""}`}
            onClick={applyFilters}
            disabled={!filtersChanged}
          >
            Применить
          </button>
        </div>
      </div>

      {currentPage === "deviations" && (
        <>
          <PivotTable
            selectedCategories={selectedCategories}
            globalWarehouse={globalWarehouse}
            globalDateFrom={globalDateFrom}
            globalDateTo={globalDateTo}
            colDim={colDim}
            onColDimChange={setColDim}
            onCellClick={handlePivotCellClick}
            hasActiveFilter={Object.keys(pivotFilters).length > 0}
          />

          {Object.keys(pivotFilters).length > 0 && (
            <div className="pivot-filter-badge">
              <span>Фильтр из таблицы: {Object.entries(pivotFilters).map(([k, v]) => `${DIM_LABELS[k] || k}=${v}`).join(", ")}</span>
              <button onClick={() => setPivotFilters({})}>✕</button>
            </div>
          )}

          <TreemapSection
            title="Отклонения — Treemap"
            filterSections={FILTER_SECTIONS}
            measureOptions={MEASURE_OPTIONS}
            defaultDims={["customer", "stage", "deviation_category", "deviation"]}
            defaultMeasure="deviation_count"
            showCategoryFilter={true}
            globalWarehouse={globalWarehouse}
            globalDateFrom={globalDateFrom}
            globalDateTo={globalDateTo}
            pivotFilters={pivotFilters}
          />
        </>
      )}

      {currentPage === "times" && (
        <>
          <TimesTreemapSection />
          <StackedBarChart />
        </>
      )}
    </div>
  );
}

export default App;
