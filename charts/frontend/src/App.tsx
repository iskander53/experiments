import { useEffect, useState, useMemo } from "react";
import Plot from "react-plotly.js";
import "./App.css";

const DIMENSION_OPTIONS = [
  "stage",
  "deviation_category",
  "deviation",
  "warehouse",
  "customer",
  "employee",
  "day",
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
  day: "День",
  hour: "Час",
  shift: "Смена",
};

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

function PivotTable({ selectedCategories }: { selectedCategories: string[] }) {
  const [rowDims, setRowDims] = useState<string[]>(["deviation_category", "deviation"]);
  const [colDim, setColDim] = useState("stage");
  const [measures, setMeasures] = useState<string[]>(["deviation_count"]);
  const [rawData, setRawData] = useState<PivotRow[]>([]);
  const [pivotLoading, setPivotLoading] = useState(false);

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

  useEffect(() => {
    setPivotLoading(true);
    const params = new URLSearchParams({
      row: rowDims.join(","),
      col: colDim,
      measures: measures.join(","),
    });
    if (selectedCategories.length > 0) {
      params.set("deviation_category", selectedCategories.join(","));
    }
    fetch(`/api/pivot?${params}`)
      .then((r) => r.json())
      .then((d: PivotRow[]) => setRawData(d))
      .catch(console.error)
      .finally(() => setPivotLoading(false));
  }, [rowDims, colDim, measures, selectedCategories]);

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

        // Accumulate measures at this level
        if (!tree[key].cells[cv]) tree[key].cells[cv] = {};
        for (const m of measures) {
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
  }, [rawData, rowDims, colDim, measures]);

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

      <div className="controls">
        <fieldset>
          <legend>Строки</legend>
          <div className="chips">
            {DIMENSION_OPTIONS.map((d) => (
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

        <fieldset>
          <legend>Столбцы</legend>
          <select value={colDim} onChange={(e) => setColDim(e.target.value)}>
            {DIMENSION_OPTIONS.map((d) => (
              <option key={d} value={d}>{DIM_LABELS[d] ?? d}</option>
            ))}
          </select>
        </fieldset>

        <fieldset>
          <legend>Метрики</legend>
          <div className="chips">
            {MEASURE_OPTIONS.map((m) => (
              <button
                key={m.value}
                className={`chip ${measures.includes(m.value) ? "active" : ""}`}
                onClick={() => toggleMeasure(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {pivotLoading ? (
        <p className="loading">Загрузка...</p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th className="row-header">{rowDims.map((d) => DIM_LABELS[d] ?? d).join(" → ")} \ {DIM_LABELS[colDim] ?? colDim}</th>
                {colValues.map((cv) => (
                  <th key={cv} colSpan={measures.length}>{cv}</th>
                ))}
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
                        return (
                          <td key={`${cv}-${m}`} className="cell">
                            {val ? fmt(val) : ""}
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
  );
}

function App() {
  const [selectedDims, setSelectedDims] = useState<string[]>(["stage"]);
  const [measure, setMeasure] = useState("deviation_count");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [data, setData] = useState<DataItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selectedDims.length === 0) return;
    setLoading(true);
    const params = new URLSearchParams({
      group_by: selectedDims.join(","),
      measure,
    });
    if (selectedCategories.length > 0) {
      params.set("deviation_category", selectedCategories.join(","));
    }
    fetch(`/api/data?${params}`)
      .then((r) => r.json())
      .then((d: DataItem[]) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedDims, measure, selectedCategories]);

  const treemap = useMemo(
    () => buildTreemap(data, selectedDims),
    [data, selectedDims]
  );

  const currentMeasure = MEASURE_OPTIONS.find((m) => m.value === measure);
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

  return (
    <div className="app">
      <h1>Отклонения — Treemap</h1>

      <div className="controls">
        <fieldset>
          <legend>Разрезы (dimensions)</legend>
          <div className="chips">
            {DIMENSION_OPTIONS.map((dim) => (
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

        <fieldset>
          <legend>Метрика (measure)</legend>
          <select value={measure} onChange={(e) => setMeasure(e.target.value)}>
            {MEASURE_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </fieldset>

        <fieldset>
          <legend>Тип отклонения (filter)</legend>
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
            <button
              className="chip reset"
              onClick={() => setSelectedCategories([])}
            >
              сбросить
            </button>
          )}
        </fieldset>
      </div>

      {loading && <p className="loading">Загрузка...</p>}

      {!loading && data.length > 0 && (
        <div className="chart-container">
          <Plot key={selectedDims.join(",") + measure}
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
        </div>
      )}
      <PivotTable selectedCategories={selectedCategories} />
    </div>
  );
}

export default App;
