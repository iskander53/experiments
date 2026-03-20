/**
 * Builds the full defects SQL query (BD + KDZ + DWC unions) with date filters.
 * Based on: DPMO BD, KDZ, DWC числитель 7.sql
 * Adds "Виновник" column (Склад / Поставщик / Получатель).
 */
function sanitizeDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date format: ${d}`);
  return d;
}

export function buildDefectsCTE(dateFrom: string, dateTo?: string): string {
  const safeDateFrom = sanitizeDate(dateFrom);
  if (dateTo) sanitizeDate(dateTo);
  const innerDateCond = `'${safeDateFrom}'`;
  const innerDateCondTs = `'${safeDateFrom}'::timestamp`;
  const innerDateCondTsNtz = `'${safeDateFrom}'::timestamp_ntz`;

  return `
WITH u AS (
    SELECT name, exceed::varchar as login, zup
    FROM DWH.ODS_MSK_RSC.V_USER WHERE zup IS NOT NULL
    GROUP BY name, exceed, zup
    UNION ALL
    SELECT name, id::varchar as login, zup
    FROM DWH.ODS_MSK_RSC.V_USER WHERE zup IS NOT NULL
    GROUP BY name, id, zup
),
zup_name AS (
    SELECT zup, max(name) AS name FROM u GROUP BY zup
),
p AS (
    SELECT zn.name, u.zup, o.sku, o.event_dttm
    FROM DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
    LEFT JOIN u ON o.user = u.login
    LEFT JOIN zup_name zn ON u.zup = zn.zup
    WHERE o.EVENT_TYPE = 'CARGO_PACK' AND o.event_dttm >= '2025-10-01'
    QUALIFY rank() OVER (PARTITION BY o.sku ORDER BY o.event_id DESC) = 1
),
cs AS (
    SELECT zn.name, u.zup, o.sku, o.event_dttm
    FROM DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
    LEFT JOIN u ON o.user = u.login
    LEFT JOIN zup_name zn ON u.zup = zn.zup
    WHERE o.EVENT_TYPE = 'CARGO_SHIP' AND o.event_dttm >= '2025-10-01'
    QUALIFY rank() OVER (PARTITION BY o.sku ORDER BY o.event_id DESC) = 1
),
gm AS (
    SELECT detail_article, max(EVENT_DTTM) AS dt
    FROM DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_EXPECTED_GOODS_ARRIVAL_TOMILINO_GOODS
    GROUP BY detail_article
),
n AS (
    SELECT detail_article, code::varchar AS code, uuid, GOODS_TYPE
    FROM DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_NOMENCLATURE
    GROUP BY detail_article, code, uuid, GOODS_TYPE
),
sku AS (
    SELECT sk.sku, sk.storerkey,
        CASE
            WHEN sk.putawayzone LIKE 'MZ%' THEN 'SMALL'
            WHEN DIV0(pz.v, (CASE
                WHEN POSITION('-' IN sk.packkey) = 0 THEN 0
                WHEN POSITION('(' IN sk.packkey) > 0 THEN SUBSTRING(sk.packkey, POSITION('-' IN sk.packkey) + 1, POSITION('(' IN sk.packkey) - POSITION('-' IN sk.packkey) -1)
                WHEN (CHARINDEX('-', sk.packkey) > 0 AND CHARINDEX('-', sk.packkey, CHARINDEX('-', sk.packkey) + 1) > 0) THEN SUBSTRING(sk.packkey, CHARINDEX('-', sk.packkey) + 1, CHARINDEX('-', sk.packkey, CHARINDEX('-', sk.packkey) + 1) - CHARINDEX('-', sk.packkey) -1)
                ELSE SUBSTRING(sk.packkey, POSITION('-' IN sk.packkey) + 1)
            END)) < 0.1 THEN 'NORMAL'
            ELSE COALESCE(sk.busr10, 'BIG')
        END AS type
    FROM DWH.ODS_MSK_PDC_ORACLE.V_SKU_ODS_UNION sk
    LEFT JOIN DWH.ODS_MSK_PDC_ORACLE.V_PUTAWAYZONE_ODS_UNION pz ON sk.whseid = pz.whseid AND sk.putawayzone = pz.putawayzone
    WHERE pz.sklad IN ('KBD', 'BD1', 'KDZ', 'KTH', 'K51', 'KKN')
      AND sk.storerkey IN ('MAS', 'AKS', 'DM', 'PCR', 'FOT', 'GAK', 'MME')
    GROUP BY sku, storerkey, type, sk.putawayzone, pz.v, sk.packkey, sk.busr10
),
prices AS (
    SELECT max(g.UNIT_PRICE) AS price, n.code AS sku
    FROM DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_EXPECTED_GOODS_ARRIVAL_TOMILINO_GOODS AS g
    INNER JOIN gm ON g.detail_article = gm.detail_article AND g.event_dttm = gm.dt
    LEFT JOIN n ON gm.detail_article = n.detail_article
    GROUP BY sku HAVING max(g.UNIT_PRICE) >= 0
),
reklamacii AS (
    SELECT
        CASE
            WHEN ec.problem_code = 'Недостача ГМ' THEN cs.event_dttm
            WHEN ec.problem_code IN ('Излишки','Пересорт','Недостача','Заводской брак','Механические повреждения','Некомплект') THEN p.event_dttm
            ELSE date_trunc(hour, TO_DATE(REGEXP_SUBSTR(link, '\\\\d{2}\\\\.\\\\d{2}\\\\.\\\\d{4}'), 'DD.MM.YYYY'))
        END AS "ДатаВремя",
        "ДатаВремя"::date AS "День",
        date_trunc(week, "ДатаВремя")::date AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        CASE
            WHEN ec.problem_code IN ('Излишки','Пересорт','Недостача','Заводской брак','Механические повреждения','Некомплект') THEN 'Упаковка'
            WHEN ec.problem_code IN ('Недостача ГМ') THEN 'Отгрузка ГМ'
            ELSE 'Неизвестно'
        END AS "Этап",
        CASE
            WHEN ec.problem_code IN ('Излишки','Недостача ГМ','Пересорт','Недостача') THEN 'По количеству'
            WHEN ec.problem_code IN ('Заводской брак','Механические повреждения','Некомплект') THEN 'По качеству'
            ELSE 'Неизвестно'
        END AS "Категория отклонения",
        CASE
            WHEN ec.problem_code = 'Излишки' THEN 'излишек'
            WHEN ec.problem_code IN ('Недостача ГМ', 'Недостача') THEN 'недостача'
            WHEN ec.problem_code IN ('Заводской брак','Механические повреждения','Некомплект') THEN 'повреждение'
            ELSE 'Неизвестно'
        END AS "Отклонение",
        ec.problem_code AS "Отклонение из источника",
        CASE
            WHEN ss.STORERKEY = 'AKS' THEN 'BD1' WHEN ss.STORERKEY = 'MAS' THEN 'BD1'
            WHEN ss.STORERKEY = 'GAK' THEN 'BD1' WHEN ss.STORERKEY = 'DM' THEN 'KBD'
            WHEN ss.STORERKEY = 'MMR' THEN 'K41' WHEN ss.STORERKEY = 'HAV' THEN 'K40'
            WHEN ss.STORERKEY = 'HIN' THEN 'KDZ' WHEN ss.STORERKEY = 'FOT' THEN 'KBD'
            WHEN ss.STORERKEY = 'MME' THEN 'BD1' WHEN ss.STORERKEY = 'PCR' THEN 'BD1'
            ELSE 'KDZ'
        END AS "Склад",
        ss.storerkey AS "Заказчик",
        count(EVENT_ID) AS "Количество отклонений",
        sum(abs(from_claim_cnt)) AS "Кол-во шт в отклонении",
        sum(PDK_CLAIM_PRICE_WITHOUT_NDS_AMT) AS "Сумма в руб. отклонений",
        concat(CASE WHEN "Этап" = 'Упаковка' THEN p.zup WHEN "Этап" = 'Отгрузка ГМ' THEN cs.zup END,' ',CASE WHEN "Этап" = 'Упаковка' THEN p.name WHEN "Этап" = 'Отгрузка ГМ' THEN cs.name END) AS user,
        ec.detail_num AS "Наименование",
        s.TYPE AS "Тип товара",
        'Склад' AS "Виновник"
    FROM dwh.emart.msk_expedition_claim AS ec
    LEFT JOIN DWH.MD.STORAGE_STORERKEY_ACTIVE AS SS ON ec.client = ss.owner
    LEFT JOIN p ON ec.box_id = p.sku AND ec.problem_code != 'Недостача ГМ'
    LEFT JOIN cs ON ec.box_id = cs.sku AND ec.problem_code = 'Недостача ГМ'
    LEFT JOIN n ON ec.detail_num_id = n.uuid
    LEFT JOIN sku s ON n.code = s.sku AND ss.storerkey = s.storerkey
    WHERE 1=1
      AND ec.problem_code NOT IN ('Опоздание', 'Инвентаризация')
      AND NOT error_stage1 IN ('Доставка ПДК','Перевозчик','Перевозчик от ЭР до Оптовика')
      AND "ДатаВремя" >= ${innerDateCond}
    GROUP BY "ДатаВремя","Этап","Категория отклонения","Отклонение","Склад","Заказчик",user,ec.detail_num,s.TYPE,ec.problem_code
),
ops AS (
    SELECT *, lag(user) OVER (PARTITION BY sku ORDER BY event_dttm) AS prev_user,
        lag(event_dttm) OVER (PARTITION BY sku ORDER BY event_dttm) AS prev_action,
        CASE WHEN prev_action IS NOT NULL THEN datediff(minute,prev_action,event_dttm) ELSE datediff(minute,event_dttm,current_timestamp()) END AS action_time,
        CASE WHEN action_time > 43200 THEN 1 ELSE 0 END AS defect30flag
    FROM DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS
),
defects30days AS (
    SELECT dateadd(minute, 43200, ops.event_dttm) AS "ДатаВремя",
        date_trunc(day, "ДатаВремя") AS "День", date_trunc(week, "ДатаВремя") AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        CASE WHEN ops.EVENT_TYPE = 'CARGO_PLACE' THEN 'Размещение ГМ' WHEN ops.EVENT_TYPE = 'CARGO_PACK' THEN 'Упаковка ГМ' WHEN ops.EVENT_TYPE IN ('CARGO_SHIP','AKS_CARGO_SHIP') THEN 'Отгрузка ГМ' END AS "Этап",
        'По количеству' AS "Категория отклонения", 'Не было движений 30+ дней' AS "Отклонение",
        'Не было движений 30+ дней' AS "Отклонение из источника",
        CASE WHEN ops.warehouse_code IN ('K41','К41') THEN 'BD1' WHEN ops.warehouse_code IN ('K40','К40') THEN 'KBD' ELSE ops.warehouse_code END AS "Склад",
        ops.storer AS "Заказчик", 1 AS "Количество отклонений", ops.sku_cnt AS "Кол-во шт в отклонении",
        ops.sku_cnt * pr.price AS "Сумма в руб. отклонений",
        COALESCE(concat(u.zup,' ',zn.name), ops.prev_user) AS user,
        ops.sku_nm AS "Наименование", 'BOX' AS "Тип товара",
        'Склад' AS "Виновник"
    FROM ops
    LEFT JOIN prices AS pr ON ops.sku = pr.sku
    LEFT JOIN u ON ops.prev_user = u.login
    LEFT JOIN zup_name zn ON u.zup = zn.zup
    WHERE ops.defect30flag = 1 AND "ДатаВремя" >= ${innerDateCond}
      AND ops.EVENT_TYPE ILIKE '%cargo%' AND ops.sku_nm != 'NONE'
),
ops_dz AS (
    SELECT *, lag(USER_ID) OVER (PARTITION BY OBJECTCODE ORDER BY OPERATION_DT) AS prev_user
    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC
    WHERE SOURCE = 'KDZ' AND OPERATION_DT >= '2025-10-01'
    QUALIFY row_number() OVER (PARTITION BY type, OBJECTKEY ORDER BY OPERATION_DT DESC) = 1
),
lost AS (
    SELECT event_dttm AS "ДатаВремя", event_dttm::date AS "День", date_trunc(week, event_dttm) AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        'Хранение' AS "Этап",
        CASE WHEN cell_to ILIKE '%lost%' OR cell_to ILIKE '%karant%' THEN 'По количеству' ELSE 'По качеству' END AS "Категория отклонения",
        CASE WHEN cell_to ILIKE '%lost%' THEN 'недостача' WHEN cell_to ILIKE '%karant%' THEN 'излишек' ELSE 'повреждение' END AS "Отклонение",
        "Отклонение" AS "Отклонение из источника",
        warehouse_code AS "Склад", storer AS "Заказчик", 1 AS "Количество отклонений",
        sku_cnt AS "Кол-во шт в отклонении", o.sku_cnt * pr.price AS "Сумма в руб. отклонений",
        COALESCE(concat(u.zup,' ',zn.name), o.prev_user) AS user,
        o.sku_nm AS "Наименование",
        CASE
            WHEN o.warehouse_zone LIKE 'MZ%' THEN 'SMALL'
            WHEN DIV0(o.warehouse_zone_volume, (CASE
                WHEN POSITION('-' IN o.sku_pack_code) = 0 THEN 0
                WHEN POSITION('(' IN o.sku_pack_code) > 0 THEN SUBSTRING(o.sku_pack_code, POSITION('-' IN o.sku_pack_code) + 1, POSITION('(' IN o.sku_pack_code) - POSITION('-' IN o.sku_pack_code) -1)
                WHEN (CHARINDEX('-', o.sku_pack_code) > 0 AND CHARINDEX('-', o.sku_pack_code, CHARINDEX('-', o.sku_pack_code) + 1) > 0) THEN SUBSTRING(o.sku_pack_code, CHARINDEX('-', o.sku_pack_code) + 1, CHARINDEX('-', o.sku_pack_code, CHARINDEX('-', o.sku_pack_code) + 1) - CHARINDEX('-', o.sku_pack_code) -1)
                ELSE SUBSTRING(o.sku_pack_code, POSITION('-' IN o.sku_pack_code) + 1)
            END)) < 0.1 THEN 'NORMAL'
            ELSE COALESCE(o.sku_busr, 'BIG')
        END AS "Тип товара",
        'Склад' AS "Виновник"
    FROM ops o LEFT JOIN prices AS pr ON o.sku = pr.sku LEFT JOIN u ON o.prev_user = u.login LEFT JOIN zup_name zn ON u.zup = zn.zup
    WHERE 1=1
      AND (cell_to ILIKE '%lost%' OR cell_to ILIKE '%bra%' OR cell_to ILIKE '%rack%')
      AND (cell_to NOT ILIKE '%dolg%' OR cell_to NOT ILIKE '%karant%')
      AND sku_cnt > 0
),
lost_supplier AS (
    SELECT event_dttm AS "ДатаВремя", event_dttm::date AS "День", date_trunc(week, event_dttm) AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        'Приемка' AS "Этап",
        CASE WHEN (cell_to ILIKE '%lost%' OR cell_to ILIKE '%karant%') THEN 'По количеству' ELSE 'По качеству' END AS "Категория отклонения",
        CASE WHEN cell_to ILIKE '%lost%' THEN 'недостача' WHEN cell_to ILIKE '%karant%' THEN 'излишек' ELSE 'повреждение' END AS "Отклонение",
        "Отклонение" AS "Отклонение из источника",
        warehouse_code AS "Склад", storer AS "Заказчик", 1 AS "Количество отклонений",
        sku_cnt AS "Кол-во шт в отклонении", o.sku_cnt * pr.price AS "Сумма в руб. отклонений",
        COALESCE(concat(u.zup,' ',zn.name), o.prev_user) AS user,
        o.sku_nm AS "Наименование",
        CASE
            WHEN o.warehouse_zone LIKE 'MZ%' THEN 'SMALL'
            WHEN DIV0(o.warehouse_zone_volume, (CASE
                WHEN POSITION('-' IN o.sku_pack_code) = 0 THEN 0
                WHEN POSITION('(' IN o.sku_pack_code) > 0 THEN SUBSTRING(o.sku_pack_code, POSITION('-' IN o.sku_pack_code) + 1, POSITION('(' IN o.sku_pack_code) - POSITION('-' IN o.sku_pack_code) -1)
                WHEN (CHARINDEX('-', o.sku_pack_code) > 0 AND CHARINDEX('-', o.sku_pack_code, CHARINDEX('-', o.sku_pack_code) + 1) > 0) THEN SUBSTRING(o.sku_pack_code, CHARINDEX('-', o.sku_pack_code) + 1, CHARINDEX('-', o.sku_pack_code, CHARINDEX('-', o.sku_pack_code) + 1) - CHARINDEX('-', o.sku_pack_code) -1)
                ELSE SUBSTRING(o.sku_pack_code, POSITION('-' IN o.sku_pack_code) + 1)
            END)) < 0.1 THEN 'NORMAL'
            ELSE COALESCE(o.sku_busr, 'BIG')
        END AS "Тип товара",
        'Поставщик' AS "Виновник"
    FROM ops o LEFT JOIN prices AS pr ON o.sku = pr.sku LEFT JOIN u ON o.prev_user = u.login LEFT JOIN zup_name zn ON u.zup = zn.zup
    WHERE 1=1
      AND (cell_to ILIKE '%dolg%' OR cell_to ILIKE '%karant%')
      AND sku_cnt > 0
),
departure_dttm AS (
    SELECT LINK, voyage_dt, SUM(VOLUME) AS LOADED_VOLUME,
        MAX(PLANNED_TOM_DEPARTURE_DTTM) AS PLANNED_TOM_DEPARTURE_DTTM,
        MAX(PLANNED_BD_DEPARTURE_DTTM) AS PLANNED_BD_DEPARTURE_DTTM,
        MAX(PLANNED_DZE_DEPARTURE_DTTM) AS PLANNED_DZE_DEPARTURE_DTTM
    FROM (
        SELECT DISTINCT LINK, TO_DATE(REGEXP_SUBSTR(Link, '\\\\d{2}\\\\.\\\\d{2}\\\\.\\\\d{4}'), 'DD.MM.YYYY') AS voyage_dt, VOLUME,
            MAX(CASE WHEN WAREHOUSE = 'Томилино' THEN DATEADD(HOUR, 3, PLANNED_DEPARTURE_DTTM) ELSE NULL END) AS PLANNED_TOM_DEPARTURE_DTTM,
            MAX(CASE WHEN WAREHOUSE IN ('Кожухово', 'Белая Дача') THEN DATEADD(HOUR, 3, PLANNED_DEPARTURE_DTTM) ELSE NULL END) AS PLANNED_BD_DEPARTURE_DTTM,
            MAX(CASE WHEN WAREHOUSE = 'Дзержинский' THEN DATEADD(HOUR, 3, PLANNED_DEPARTURE_DTTM) ELSE NULL END) AS PLANNED_DZE_DEPARTURE_DTTM
        FROM DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_VOYAGE_LOAD_WAREHOUSE
        WHERE WAREHOUSE IN ('Томилино','Кожухово','Белая Дача','Дзержинский')
        GROUP BY 1,2,3
    ) GROUP BY 1,2
),
data AS (
    SELECT DISTINCT d.CONSIGNEE, d.CLIENT, d.DELIVERY_CITY, d.DROPID, d.LAST_WAREHOUSE,
        d.VOYAGE_NUM, d.VOYAGE_LINK, d.ROUTE_PDC, d.NEW_LOADED_VOLUME, d.NEW_CAR_VOLUME,
        dd.PLANNED_TOM_DEPARTURE_DTTM, dd.PLANNED_BD_DEPARTURE_DTTM, dd.PLANNED_DZE_DEPARTURE_DTTM,
        d.DELIVERY_ORDER_DTTM, d.PARCELMOVED_EV_DTTM,
        CASE
            WHEN d.LAST_WAREHOUSE IN ('БД', 'БД1') THEN dd.PLANNED_BD_DEPARTURE_DTTM
            WHEN d.LAST_WAREHOUSE IN ('К41', 'К40', 'KTH', 'KKN') THEN dd.PLANNED_TOM_DEPARTURE_DTTM
            WHEN d.LAST_WAREHOUSE = 'ДЗ' THEN dd.PLANNED_DZE_DEPARTURE_DTTM ELSE NULL
        END AS PLANNED_DEPARTURE_DTTM
    FROM DWH.EMART.HWC_BOXES_LIFECYCLE AS d
    LEFT JOIN departure_dttm AS dd ON d.VOYAGE_LINK = dd.LINK
    WHERE DATE(d.PARCELMOVED_EV_DTTM) >= ${innerDateCond}
      AND d.ROUTE_PDC NOT ILIKE '%самов%' AND d.ROUTE_PDC NOT ILIKE '%авиа%'
      AND d.ROUTE_PDC NOT ILIKE '%разовая%' AND d.ROUTE_PDC NOT ILIKE '%пустенько%'
      AND d.ROUTE_PDC NOT ILIKE '%шатл%' AND d.ROUTE_PDC NOT ILIKE '%шаттл%'
      AND d.ROUTE_PDC NOT ILIKE '%переброс%' AND d.ROUTE_PDC NOT ILIKE '%переезд%'
      AND d.CARRIER NOT ILIKE '%самов%'
),
ROUTES AS (
    SELECT * FROM (
        SELECT CONSIGNEE, DELIVERY_CITY, LAST_WAREHOUSE, ROUTE_PDC, COUNT(DISTINCT(DROPID)) AS DROPIDS
        FROM data GROUP BY CONSIGNEE, DELIVERY_CITY, LAST_WAREHOUSE, ROUTE_PDC
    ) WHERE DROPIDS > 5 AND ROUTE_PDC IS NOT NULL AND LAST_WAREHOUSE IS NOT NULL
),
able_routes AS (
    SELECT DISTINCT LAST_WAREHOUSE, VOYAGE_NUM, ROUTE_PDC,
        PLANNED_TOM_DEPARTURE_DTTM, PLANNED_BD_DEPARTURE_DTTM, PLANNED_DZE_DEPARTURE_DTTM,
        CASE
            WHEN LAST_WAREHOUSE IN ('БД', 'БД1') THEN PLANNED_BD_DEPARTURE_DTTM
            WHEN LAST_WAREHOUSE IN ('К41', 'К40', 'KTH', 'KKN') THEN PLANNED_TOM_DEPARTURE_DTTM
            WHEN LAST_WAREHOUSE = 'ДЗ' THEN PLANNED_DZE_DEPARTURE_DTTM ELSE NULL
        END AS POTENTIAL_PLANNED_DEPARTURE_DTTM,
        NEW_LOADED_VOLUME / NEW_CAR_VOLUME * 100 AS UTIL
    FROM data
),
final_res AS (
    SELECT PARCELMOVED_EV_DTTM AS dt, DATE_TRUNC('day', PARCELMOVED_EV_DTTM) AS Day,
        DATE_TRUNC('week', PARCELMOVED_EV_DTTM) AS W,
        CASE WHEN LAST_WAREHOUSE = 'БД' THEN 'KBD' WHEN LAST_WAREHOUSE = 'БД1' THEN 'BD1'
            WHEN CLIENT = 'АвтоБиз' THEN 'BD1' WHEN LAST_WAREHOUSE = 'ДЗ' THEN 'KDZ' END AS WH,
        CLIENT AS STORER, DROPID,
        CASE
            WHEN rn = 1 AND (POTENTIAL_PLANNED_DEPARTURE_DTTM = PLANNED_DEPARTURE_DTTM) THEN DROPID
            WHEN PREV_UTIL > 70 AND rn = 2 AND (POTENTIAL_PLANNED_DEPARTURE_DTTM = PLANNED_DEPARTURE_DTTM) THEN DROPID
            ELSE NULL
        END AS "ГМ_ОТГРУЖЕНО_В_БЛИЖАЙШЕМ_РЕЙСЕ",
        POTENTIAL_VOYAGE_NUM
    FROM (
        SELECT *, LAG(UTIL) OVER(PARTITION BY DROPID ORDER BY POTENTIAL_PLANNED_DEPARTURE_DTTM) AS PREV_UTIL,
            row_number() OVER (PARTITION BY DROPID ORDER BY POTENTIAL_PLANNED_DEPARTURE_DTTM ASC) AS rn
        FROM (
            SELECT DISTINCT d.CONSIGNEE, d.CLIENT, d.DELIVERY_CITY, d.DROPID,
                d.DELIVERY_ORDER_DTTM, d.PARCELMOVED_EV_DTTM, d.LAST_WAREHOUSE,
                d.VOYAGE_NUM, d.ROUTE_PDC AS d_ROUTE_PDC,
                d.PLANNED_TOM_DEPARTURE_DTTM, d.PLANNED_BD_DEPARTURE_DTTM, d.PLANNED_DZE_DEPARTURE_DTTM, d.PLANNED_DEPARTURE_DTTM,
                r.ROUTE_PDC AS r_ROUTE_PDC, r.DROPIDS,
                p2.ROUTE_PDC AS POTENTIAL_ROUTE_PDC, p2.VOYAGE_NUM AS POTENTIAL_VOYAGE_NUM,
                p2.PLANNED_TOM_DEPARTURE_DTTM AS POTENTIAL_PLANNED_TOM_DEPARTURE_DTTM,
                p2.PLANNED_BD_DEPARTURE_DTTM AS POTENTIAL_PLANNED_BD_DEPARTURE_DTTM,
                p2.PLANNED_DZE_DEPARTURE_DTTM AS POTENTIAL_PLANNED_DZE_DEPARTURE_DTTM,
                p2.POTENTIAL_PLANNED_DEPARTURE_DTTM, p2.UTIL,
                DATEDIFF(millisecond, d.PARCELMOVED_EV_DTTM, p2.POTENTIAL_PLANNED_DEPARTURE_DTTM) TIME_DIFF
            FROM data AS d
            LEFT JOIN ROUTES AS r ON d.CONSIGNEE = r.CONSIGNEE AND d.LAST_WAREHOUSE = r.LAST_WAREHOUSE AND d.DELIVERY_CITY = r.DELIVERY_CITY
            LEFT JOIN able_routes AS p2 ON d.LAST_WAREHOUSE = p2.LAST_WAREHOUSE AND r.ROUTE_PDC = p2.ROUTE_PDC
                AND p2.POTENTIAL_PLANNED_DEPARTURE_DTTM > d.PARCELMOVED_EV_DTTM
                AND p2.POTENTIAL_PLANNED_DEPARTURE_DTTM <= d.PLANNED_DEPARTURE_DTTM
            WHERE 1=1 AND (TIME_DIFF >= 0 OR TIME_DIFF IS NULL) AND NOT d.VOYAGE_NUM IS NULL
        )
    ) WHERE 1=1 GROUP BY ALL
),
price_subid AS (
    SELECT ORDERDETAILSUBID, max(detailpricebuyrur) AS detailpricebuyrur
    FROM DWH.ODS_MSK_EMEXMAIN_DBO.INVOICESDETAILS GROUP BY ORDERDETAILSUBID
),
gm_not_first_voyage AS (
    SELECT f.dt AS "ДатаВремя", f.Day AS "День", f.W AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        'Отгрузка ГМ' AS "Этап", 'По времени' AS "Категория отклонения", 'Опоздание' AS "Отклонение",
        'ГМ не отгружено в 1й рейс' AS "Отклонение из источника",
        f.wh AS "Склад", ska.storerkey AS "Заказчик", 1 AS "Количество отклонений",
        CASE WHEN f.wh != 'KDZ' THEN sum(pd.qty) ELSE sum(rd.DETAILQUANTITY) END AS "Кол-во шт в отклонении",
        0 AS "Сумма в руб. отклонений",
        CASE WHEN f.wh != 'KDZ' THEN COALESCE(concat(u.zup,' ',u.name), o.prev_user)
            ELSE COALESCE(concat(udz.TABNUMBER,' ',udz.USERNAME), dz.prev_user)
        END AS user,
        f.dropid AS "Наименование", 'BOX' AS "Тип товара",
        'Склад' AS "Виновник"
    FROM final_res f
    LEFT JOIN DWH.MD.STORAGE_STORERKEY_ACTIVE ska ON f.STORER = ska.owner
    LEFT JOIN DWH.ODS_MSK_PDC_ORACLE.V_DROPIDDETAIL_ODS_UNION dd ON f.DROPID = dd.DROPID
    LEFT JOIN DWH.ODS_MSK_PDC_ORACLE.V_PICKDETAIL_ODS_UNION pd ON pd.CASEID = dd.CHILDID
    LEFT JOIN DWH.ODS_MSK_PDC_ORACLE.V_SKU_ODS_UNION sk ON pd.SKU = sk.sku AND pd.WHSEID = sk.WHSEID AND pd.STORERKEY = sk.STORERKEY
    LEFT JOIN prices AS pr ON sk.sku = pr.sku
    LEFT JOIN ops o ON f.dropid = o.sku AND o.EVENT_TYPE = 'CARGO_SHIP'
    LEFT JOIN ops_dz dz ON f.dropid = dz.OBJECTCODE AND dz.TYPE = 'CARGO_SHIP'
    LEFT JOIN u ON o.prev_user = u.login
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.USERS udz ON dz.prev_user = udz.userid
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.BOXESREGIONS br ON f.dropid = br.barcode
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.RECEIPTSDETAILS rd ON br.boxregid = rd.boxregid
    LEFT JOIN price_subid id ON rd.orderdetailsubid = id.ORDERDETAILSUBID
    WHERE 1=1 AND "ГМ_ОТГРУЖЕНО_В_БЛИЖАЙШЕМ_РЕЙСЕ" IS NULL AND POTENTIAL_VOYAGE_NUM IS NOT NULL
    GROUP BY f.dt,f.Day,f.W,f.wh,ska.storerkey,u.zup,u.name,o.prev_user,f.dropid,udz.TABNUMBER,udz.USERNAME,dz.prev_user
),
defects_bd AS (
    SELECT DISTINCT * FROM lost
    UNION ALL SELECT DISTINCT * FROM reklamacii
    UNION ALL SELECT DISTINCT * FROM gm_not_first_voyage
    UNION ALL SELECT DISTINCT * FROM defects30days
    UNION ALL SELECT DISTINCT * FROM lost_supplier
),
BD_UNION AS (SELECT * FROM defects_bd WHERE "ДатаВремя" >= ${innerDateCond}),

kdz_ops_all AS (
    SELECT o.*,
        LAG(o.USERNAME) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT) AS prev_username,
        LAG(o.TYPE) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT) AS prev_type,
        LAST_VALUE(o.DETAILPRICEBUY) IGNORE NULLS OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS price_eff,
        COALESCE(NULLIF(o.ITEMS, 0), 1) AS qty_eff,
        CASE
            WHEN o.TYPE IN ('RECEIPTING','STOCK_RECEIPTING') THEN 'Приемка'
            WHEN o.TYPE IN ('PICK','STOCK_PICK','STOCK_PICKING') THEN 'Подбор'
            WHEN o.TYPE = 'PLACE' THEN 'Размещение'
            WHEN o.TYPE IN ('SORT','PRESORTING') THEN 'Сортировка'
            WHEN o.TYPE IN ('PACK','REPACK') THEN 'Упаковка'
            WHEN o.TYPE IN ('EXPERT','EXPERTISE') THEN 'Экспертиза'
            WHEN o.TYPE = 'INVENTORY' THEN 'Хранение'
            WHEN o.TYPE = 'BOX_PLACE' THEN 'Размещение коробов'
            WHEN o.TYPE IN ('CARGO_PLACE','CARGO_PICK','CARGO_SHIP') THEN 'Отгрузка'
            ELSE o.TYPE
        END AS stage_curr
    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC o
    WHERE o.OPERATION_DT >= DATEADD('day', -30, ${innerDateCondTs})
      AND o.SOURCE = 'KDZ'
      AND o.TYPE IS NOT NULL AND o.TYPE != 'UNKNOWN'
),
kdz_ops_gaps AS (
    SELECT o.*,
        CASE WHEN LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT) IS NULL THEN current_date()
        ELSE LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT) END AS next_op_dt
    FROM kdz_ops_all o
),
kdz_defect_events AS (
    SELECT o.OPERATION_DT AS "ДатаВремя",
        DATE_TRUNC('day', o.OPERATION_DT)::date AS "День",
        DATEADD('day', -(DAYOFWEEKISO(o.OPERATION_DT) - 1), DATE_TRUNC('day', o.OPERATION_DT))::date AS "Неделя",
        DATE_PART('hour', o.OPERATION_DT) AS "Час",
        CASE WHEN DATE_PART('hour', o.OPERATION_DT) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        CASE
            WHEN o.prev_type IN ('RECEIPTING','STOCK_RECEIPTING') THEN 'Приемка'
            WHEN o.prev_type IN ('PICK','STOCK_PICK','STOCK_PICKING') THEN 'Подбор'
            WHEN o.prev_type = 'PLACE' THEN 'Размещение'
            WHEN o.prev_type IN ('SORT','PRESORTING') THEN 'Сортировка'
            WHEN o.prev_type IN ('PACK','REPACK') THEN 'Упаковка'
            WHEN o.prev_type IN ('EXPERT','EXPERTISE') THEN 'Экспертиза'
            WHEN o.prev_type = 'INVENTORY' THEN 'Хранение'
            WHEN o.prev_type = 'BOX_PLACE' THEN 'Размещение коробов'
            WHEN o.prev_type = 'UNKNOWN' THEN 'Неизвестно'
            ELSE o.prev_type
        END AS "Этап",
        'По количеству' AS "Категория отклонения", 'недостача' AS "Отклонение",
        'недостача' AS "Отклонение из источника",
        'KDZ' AS "Склад", COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        'Склад' AS "Виновник",
        o.qty_eff AS claim_qty, COALESCE(o.price_eff, 0) AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,
        COALESCE(o.prev_username, o.USERNAME) AS "USER",
        o.DETAILNAME AS "Наименование", o.ITEM_TYPE AS "Тип товара", o.OBJECTCODE::VARCHAR AS OBJECTCODE
    FROM kdz_ops_all o
    WHERE o.TOPLACECODE IN ('888888', 'LOST') AND o.OPERATION_DT >= ${innerDateCondTs}
      AND o.prev_type IS NOT NULL AND o.prev_type != 'UNKNOWN'
),
kdz_reclamation_events AS (
    SELECT ret.CREATEDATE AS "ДатаВремя",
        DATE_TRUNC('day', ret.CREATEDATE)::date AS "День",
        DATEADD('day', -(DAYOFWEEKISO(ret.CREATEDATE) - 1), DATE_TRUNC('day', ret.CREATEDATE))::date AS "Неделя",
        DATE_PART('hour', ret.CREATEDATE) AS "Час",
        CASE WHEN DATE_PART('hour', ret.CREATEDATE) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        CASE
            WHEN r.REASONID IN (435,425,4,11,102,103,432,8,411,436) THEN 'Приемка'
            WHEN r.REASONID IN (101,431) THEN 'Получатель'
            ELSE 'Упаковка'
        END AS "Этап",
        CASE WHEN r.REASONID IN (412,104,434,425,4,106,432,426) THEN 'По качеству' ELSE 'По количеству' END AS "Категория отклонения",
        CASE
            WHEN r.REASONID IN (436,431) THEN 'Неизвестно'
            WHEN r.REASONID IN (12,427) THEN 'пересорт'
            WHEN r.REASONID IN (435,11,103,102,107,105,111,9,433,110,109) THEN 'недостача'
            WHEN r.REASONID IN (108) THEN 'излишек'
            WHEN r.REASONID IN (426,4,106) THEN 'брак'
            WHEN r.REASONID IN (425,411) THEN 'контрафакт'
            WHEN r.REASONID IN (412,104,434,432) THEN 'повреждение'
            WHEN r.REASONID = 101 THEN 'Безусловный возврат'
            ELSE 'Неизвестно'
        END AS "Отклонение",
        "Отклонение" AS "Отклонение из источника",
        'KDZ' AS "Склад", COALESCE(g.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        CASE
            WHEN r.REASONID IN (435,425,4,11,102,103,432,8,411,436,426) THEN 'Поставщик'
            WHEN r.REASONID IN (101,431) THEN 'Получатель'
            ELSE 'Склад'
        END AS "Виновник",
        COALESCE(g.qty_eff, 1) AS claim_qty, COALESCE(g.price_eff, 0) AS unit_price,
        COALESCE(g.qty_eff, 1) * COALESCE(g.price_eff, 0) AS claim_amount,
        g.USERNAME AS "USER", g.DETAILNAME AS "Наименование", g.ITEM_TYPE AS "Тип товара",
        g.OBJECTCODE::VARCHAR AS OBJECTCODE
    FROM dwh.ods_msk_online_dbo.reclamation r
    LEFT JOIN dwh.ods_msk_emexmain_dbo.returns ret ON r.RETURNID = ret.ID
    LEFT JOIN kdz_ops_gaps g ON g.SUB_ID::VARCHAR = r.ORDERDETAILSUBID::VARCHAR AND g.OPERATION_DT <= r.LASTMODIFIED
    WHERE ret.CREATEDATE >= ${innerDateCond} AND r.LASTMODIFIED >= ${innerDateCond}
      AND r.DELETED_FLG = FALSE AND ret.DELETED_FLG = FALSE
      AND r.REASONID IN (12,435,101,107,426,105,425,111,412,4,11,9,108,102,104,427,106,103,433,436,110,434,431,432,109,8,411)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY r.RECLAMATIONID ORDER BY g.OPERATION_DT DESC) = 1
),
kdz_time_defect_events AS (
    SELECT DATEADD('day', 30, o.OPERATION_DT) AS "ДатаВремя",
        DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT))::date AS "День",
        DATEADD('day', -(DAYOFWEEKISO(DATEADD('day', 30, o.OPERATION_DT)) - 1), DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT)))::date AS "Неделя",
        DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) AS "Час",
        CASE WHEN DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        o.stage_curr AS "Этап", 'По количеству' AS "Категория отклонения", 'Не было движений 30+ дней' AS "Отклонение",
        'Не было движений 30+ дней' AS "Отклонение из источника",
        'KDZ' AS "Склад", COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        'Склад' AS "Виновник",
        o.qty_eff AS claim_qty, COALESCE(o.price_eff, 0) AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,
        o.USERNAME AS "USER", o.DETAILNAME AS "Наименование", o.ITEM_TYPE AS "Тип товара",
        o.OBJECTCODE::VARCHAR AS OBJECTCODE
    FROM kdz_ops_gaps o
    WHERE 1=1 AND DATEDIFF('day', o.OPERATION_DT, o.next_op_dt) >= 30
      AND DATEADD('day', 30, o.OPERATION_DT) >= ${innerDateCondTs}
      AND o.TYPE NOT IN ('BOX_PLACE','PICK','STOCK_PICK','STOCK_PICKING','PLACE','CARGO_SHIP','STOCK_INVENTORY','STOCK_PLACE')
),
base_operations AS (
    SELECT t.OBJECTCODE, st.DETAILID, t.OBJECTTYPEID,
        CASE WHEN t.OBJECTTYPEID=1 THEN 'Позиция' WHEN t.OBJECTTYPEID=2 THEN 'Тара' WHEN t.OBJECTTYPEID=3 THEN 'Коробка' WHEN t.OBJECTTYPEID=4 THEN 'Внут.тара' WHEN t.OBJECTTYPEID=5 THEN 'Возврат' END AS object_type,
        CASE WHEN t.shippingdate IS NOT NULL THEN 'SHIPPING' WHEN t.packingdate IS NOT NULL THEN 'PACK' WHEN t.pickingdate IS NOT NULL THEN 'PICK' WHEN t.placementdate IS NOT NULL THEN 'PLACE' WHEN t.sortingzonedate IS NOT NULL THEN 'SORT' WHEN t.repackdate IS NOT NULL THEN 'REPACK' WHEN t.expertdate IS NOT NULL THEN 'EXPERTISE' WHEN t.receiptdate IS NOT NULL THEN 'RECEIPTING' WHEN t.placementplace = t.receiptplace THEN 'INVENTORY' ELSE 'UNKNOWN' END AS current_stage,
        CASE WHEN t.shippingdate IS NOT NULL THEN t.shippinguserid WHEN t.packingdate IS NOT NULL THEN t.packinguserid WHEN t.pickingdate IS NOT NULL THEN t.pickinguserid WHEN t.placementdate IS NOT NULL THEN t.placementuserid WHEN t.sortingzonedate IS NOT NULL THEN t.sortingzoneuserid WHEN t.repackdate IS NOT NULL THEN t.repackuserid WHEN t.expertdate IS NOT NULL THEN t.expertuserid WHEN t.receiptdate IS NOT NULL THEN t.receiptuserid ELSE NULL END AS current_userid,
        CASE WHEN t.shippingdate IS NOT NULL THEN t.shippingdate WHEN t.packingdate IS NOT NULL THEN t.packingdate WHEN t.pickingdate IS NOT NULL THEN t.pickingdate WHEN t.placementdate IS NOT NULL THEN t.placementdate WHEN t.sortingzonedate IS NOT NULL THEN t.sortingzonedate WHEN t.repackdate IS NOT NULL THEN t.repackdate WHEN t.expertdate IS NOT NULL THEN t.expertdate WHEN t.receiptdate IS NOT NULL THEN t.receiptdate ELSE NULL END AS current_stage_dt,
        t.RECEIPTUSERID, t.RECEIPTDATE, t.EXPERTUSERID, t.EXPERTDATE, t.SORTINGZONEUSERID, t.SORTINGZONEDATE,
        t.PLACEMENTUSERID, t.PLACEMENTDATE, t.PICKINGUSERID, t.PICKINGDATE, t.PACKINGUSERID, t.PACKINGDATE,
        t.SHIPPINGUSERID, t.SHIPPINGDATE, t.REPACKUSERID, t.REPACKDATE,
        d.DETAILNAME, idetails.DETAILPRICEBUYRUR, st.PlaceId AS CurrentPlace
    FROM DWH.ODS_MSK_STOREDWH_MOTIVATION.OPERATIONS t
    LEFT JOIN DWH.ODS_MSK_EMEXWMS_STORAGE.STOCK st ON t.OBJECTCODE = st.CODE
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.INVOICESDETAILS idetails ON TO_VARCHAR(t.OBJECTKEY) = TO_VARCHAR(idetails.ORDERDETAILSUBID)
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.CUSTOMERORDERSDETAILS cod ON CAST(REGEXP_REPLACE(t.OBJECTCODE::varchar, '^\\\\*\\\\d{4}|/.*$', '') AS varchar) = cod.ORDERDETAILSUBID::varchar
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.DETAILS d ON cod.DETAILID = d.DETAILID
    WHERE t.RECEIPTDATE >= ${innerDateCond} AND t.DELETED_FLG = FALSE AND t.OBJECTCODE LIKE '*%'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY t.OBJECTCODE ORDER BY t.RECEIPTDATE DESC) = 1
),
moving AS (
    SELECT UNITCODE AS OBJECTCODE, ITEM_TYPE, TYPE
    FROM DWH.ODS_MSK_EMEXTRACK_STORAGE.V_MOVING
    WHERE date >= ${innerDateCond} AND TOPLACECODE NOT LIKE '(%' AND TOPLACECODE NOT LIKE 'РСЦ%' AND UNITCODE NOT LIKE '.42%' AND OPERATIONTYPEID IN (1,2)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY UNITCODE ORDER BY date DESC) = 1
),
reject_data AS (
    SELECT rd.CODE, rdr.Reason, rd.QUANTITY
    FROM DWH.ODS_MSK_EMEXWMS_RECEIPT.RECEIPTDETAILREJECT rdr
    JOIN DWH.ODS_MSK_EMEXWMS_RECEIPT.RECEIPTDETAIL rd ON rd.RECEIPTDETAILID = rdr.RECEIPTDETAILID
),
defect_flags_kdz AS (
    SELECT op.OBJECTCODE, op.DETAILNAME, m.item_type, op.DETAILPRICEBUYRUR, r.QUANTITY AS claim_ct,
        TRY_CAST(SUBSTR(SUBSTR(op.OBJECTCODE, 1, 5), 4, 2) AS INTEGER) AS item_qty,
        op.current_stage, op.current_stage_dt AS IncomeDate,
        CASE WHEN COALESCE(op.PLACEMENTDATE, CURRENT_TIMESTAMP()) > DATEADD(HOUR, 24, op.RECEIPTDATE) THEN 1 ELSE 0 END AS d13,
        CASE WHEN (DATEDIFF('mi', op.PICKINGDATE, op.SHIPPINGDATE)) / 60.0 > 24 THEN 1 ELSE 0 END AS d16,
        CASE WHEN op.CurrentPlace = 3550 THEN 1 ELSE 0 END AS d12,
        CASE WHEN op.CurrentPlace = 2154 THEN 1 ELSE 0 END AS d18,
        CASE WHEN r.Reason ILIKE '%Излишек%' THEN 1 ELSE 0 END AS d11,
        CASE WHEN op.CurrentPlace = 20 THEN 1 ELSE 0 END AS d26,
        CASE WHEN r.Reason ILIKE '%Повреждение%' THEN 1 ELSE 0 END AS d21,
        CASE WHEN r.Reason ILIKE '%маркиров%' THEN 1 ELSE 0 END AS d22,
        CASE WHEN r.Reason ILIKE '%Недостач%' THEN 1 ELSE 0 END AS d23,
        CASE WHEN r.Reason ILIKE '%Отказ%' THEN 1 ELSE 0 END AS d24,
        CASE WHEN r.Reason ILIKE '%Отмен%' THEN 1 ELSE 0 END AS d25
    FROM base_operations op
    LEFT JOIN reject_data r ON op.OBJECTCODE = r.CODE
    LEFT JOIN moving m ON op.objectcode = m.objectcode
),
source_kdz_detail AS (
    SELECT OBJECTCODE, item_type, DETAILNAME,
        DATE_TRUNC('HOUR', IncomeDate) AS "ДатаВремя",
        DATE_TRUNC('DAY', IncomeDate) AS "День",
        DATEADD('DAY', -(DAYOFWEEKISO(IncomeDate) - 1), DATE_TRUNC('DAY', IncomeDate)) AS "Неделя",
        DATE_PART('HOUR', IncomeDate) AS "Час",
        current_stage AS stage, type, problem_code,
        DETAILPRICEBUYRUR AS claim_price, claim_ct,
        COALESCE(NULLIF(item_qty, 0), 1) AS item_qty,
        'EMEX' AS storerkey, 'KDZ' AS sklad
    FROM (
        SELECT *, 'Lost' AS type, 'Потери' AS problem_code FROM defect_flags_kdz WHERE d12 = 1
        UNION ALL SELECT *, 'Error' AS type, 'Излишки' AS problem_code FROM defect_flags_kdz WHERE d11 = 1
        UNION ALL SELECT *, 'Error' AS type, 'Потеряно при подборе' AS problem_code FROM defect_flags_kdz WHERE d26 = 1
        UNION ALL SELECT *, 'Error' AS type, 'Повреждение' AS problem_code FROM defect_flags_kdz WHERE d21 = 1
        UNION ALL SELECT *, 'Error' AS type, 'Без маркировки' AS problem_code FROM defect_flags_kdz WHERE d22 = 1
        UNION ALL SELECT *, 'Error' AS type, 'Недостача' AS problem_code FROM defect_flags_kdz WHERE d23 = 1
    ) d
),
kdz_sup_def AS (
    SELECT "ДатаВремя","День","Неделя","Час",
        CASE WHEN "Час" BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        'Приемка' AS "Этап",
        CASE WHEN problem_code IN ('Повреждение','Без маркировки') THEN 'По качеству' ELSE 'По количеству' END AS "Категория отклонения",
        CASE
            WHEN problem_code = 'Потери' THEN 'недостача' WHEN problem_code = 'Излишки' THEN 'излишек'
            WHEN problem_code = 'Потеряно при подборе' THEN 'недостача' WHEN problem_code = 'Повреждение' THEN 'повреждение'
            WHEN problem_code = 'Без маркировки' THEN 'повреждение упаковки' WHEN problem_code = 'Недостача' THEN 'недостача'
            ELSE problem_code
        END AS "Отклонение",
        problem_code AS "Отклонение из источника",
        sklad AS "Склад", storerkey AS "Заказчик", 'Поставщик' AS "Виновник",
        COALESCE(claim_ct, item_qty, 1) AS claim_qty, COALESCE(claim_price, 0) AS unit_price,
        COALESCE(claim_price, 0) * COALESCE(claim_ct, item_qty, 1) AS claim_amount,
        NULL::VARCHAR AS "USER", DETAILNAME AS "Наименование", ITEM_TYPE AS "Тип товара",
        OBJECTCODE::VARCHAR AS OBJECTCODE
    FROM source_kdz_detail
),
all_defects_kdz AS (
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_qty,unit_price,claim_amount,"USER","Наименование","Тип товара",OBJECTCODE FROM kdz_defect_events
    UNION ALL
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_qty,unit_price,claim_amount,"USER","Наименование","Тип товара",OBJECTCODE FROM kdz_time_defect_events
    UNION ALL
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_qty,unit_price,claim_amount,"USER","Наименование","Тип товара",OBJECTCODE FROM kdz_reclamation_events
    UNION ALL
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_qty,unit_price,claim_amount,"USER","Наименование","Тип товара",OBJECTCODE FROM kdz_sup_def
),
kdz_union AS (
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик",
        COUNT(DISTINCT OBJECTCODE) AS "Количество отклонений",
        SUM(claim_qty) AS "Кол-во шт в отклонении",
        SUM(claim_amount) AS "Сумма в руб. отклонений",
        "USER","Наименование","Тип товара","Виновник"
    FROM all_defects_kdz
    GROUP BY "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","USER","Наименование","Тип товара","Виновник"
),

user_mapping AS (
    SELECT USER_ID, dwc_id FROM DWH.REPLICA_VDOCKERPSQL1_EMEXUAE.V_LKP_LKD_API_TOKENS WHERE dwc_id IS NOT NULL
),
cm_parcel AS (
    SELECT * FROM DWH.ODS_UAE_RSC.V_CORE_MOVE
    WHERE operation IN ('picking','wrapping') AND entity_subtype IN ('Parcel','Box') AND event_dttm >= ${innerDateCond}
),
dwc_customers AS (
    SELECT cd.ORDERDETAILSUBID, c.customerlogo, c.CUSTOMERNAME, cd.orderid
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.CUSTOMERORDERSDETAILS cd
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.CUSTOMERORDERS co ON cd.orderid = co.orderid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.CUSTOMERS c ON co.customerid = c.customerid
    GROUP BY 1,2,3,4
),
pack_boxes AS (
    SELECT substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) AS objectcode,
        substring(object_to, position('(' IN object_to) + 1) AS object_to
    FROM cm_parcel WHERE event_dttm >= ${innerDateCond} AND operation = 'wrapping' AND ENTITY_SUBTYPE = 'Parcel'
    GROUP BY 1,2
),
wh_ops AS (
    SELECT CONCAT(wol.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        CASE WHEN OPERATION LIKE '%_%' THEN SPLIT_PART(OPERATION, '_', 1) ELSE OPERATION END AS type,
        wol.EVENTDATE AS dt, wol.EVENTUSER::varchar AS user_id, rd.DETAILID, rd.RECEIPTSDETAILID,
        id.DETAILQUANTITY AS detail_qty, id.DETAILPRICEBUY AS detail_price,
        rd.detailquantity AS qty, wol.HOSTNAME,
        NULL AS object_from,
        CASE WHEN type = 'PACKING' THEN pb.object_to ELSE NULL END AS object_to,
        NULL AS loc_from, NULL AS loc_to,
        CASE WHEN rd.BITBIG = TRUE THEN 'BIG' WHEN rd.SORTTYPEID = 1 THEN 'SMALL' WHEN rd.SORTTYPEID IN (2,3) THEN 'NORMAL' END AS item_type,
        cu.customerlogo, cu.CUSTOMERNAME, cu.orderid,
        des.destinationlogo, sup.SUPPLIERLOGO,
        i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.V_TBL_WAREHOUSE_OPERATIONLOG wol
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd ON wol.receiptdetailid = rd.RECEIPTSDETAILID
    LEFT JOIN dwc_customers cu ON wol.orderdetailsubid = cu.orderdetailsubid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.DESTS des ON rd.destinationid = des.destinationid
    LEFT JOIN pack_boxes pb ON CONCAT(wol.ORDERDETAILSUBID, '_', rd.portion) = pb.objectcode
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE eventdate >= ${innerDateCond} AND OPERATION NOT LIKE '%BOX%' AND OPERATION NOT LIKE '%SCAN%' AND USER_ID != 44
),
rc_ops AS (
    SELECT CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        'RECEIPTING' AS type, rd.RECEIPTSDETAILSDATE AS dt, rd.ReceiptUserId::varchar AS user_id,
        rd.DETAILID, rd.RECEIPTSDETAILID, rd.detailquantity AS qty,
        id.DETAILQUANTITY AS detail_qty, id.DETAILPRICEBUY AS detail_price,
        rd.RECEIPTPLACE AS HOSTNAME, NULL AS object_from, NULL AS object_to, NULL AS loc_from, NULL AS loc_to,
        CASE WHEN rd.BITBIG = TRUE THEN 'BIG' WHEN rd.SORTTYPEID = 1 THEN 'SMALL' WHEN rd.SORTTYPEID IN (2,3) THEN 'NORMAL' END AS item_type,
        cu.customerlogo, cu.CUSTOMERNAME, cu.orderid,
        des.destinationlogo, sup.SUPPLIERLOGO,
        i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
    LEFT JOIN dwc_customers cu ON rd.orderdetailsubid = cu.orderdetailsubid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.DESTS des ON rd.destinationid = des.destinationid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE RECEIPTSDETAILSDATE >= ${innerDateCond} AND rd.DELETED_FLG = FALSE AND USER_ID != 44
),
pc_ops AS (
    SELECT substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) AS objectcode,
        'PICK' AS type, cm.event_dttm AS dt, u2.dwc_id::varchar AS user_id,
        rd.DETAILID, rd.RECEIPTSDETAILID, entity_content_quantity AS qty,
        id.DETAILQUANTITY AS detail_qty, id.DETAILPRICEBUY AS detail_price,
        NULL AS HOSTNAME, NULL AS object_from, substring(object_to, position('(' IN object_to) + 1) AS object_to,
        cm.CELLFROM_CODE AS loc_from, cm.CELLTO_CODE AS loc_to,
        CASE WHEN rd.BITBIG = TRUE THEN 'BIG' WHEN rd.SORTTYPEID = 1 THEN 'SMALL' WHEN rd.SORTTYPEID IN (2,3) THEN 'NORMAL' END AS ITEM_TYPE,
        left(cm.destination, 4) AS customerlogo, NULL AS customername, NULL AS orderid,
        right(cm.destination, 4) AS destinationlogo, sup.SUPPLIERLOGO,
        i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM cm_parcel cm
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd ON substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) = concat(rd.orderdetailsubid, '_', rd.portion)
    LEFT JOIN user_mapping u2 ON cm.user_id = u2.user_id
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE cm.operation = 'picking' AND cm.entity_subtype = 'Parcel' AND cm.PARENT_ID IS NOT NULL
      AND cm.object_to LIKE 'TR_%' AND cm.event_dttm >= ${innerDateCond} AND u2.dwc_id != 44
),
pc_sm_ops AS (
    SELECT substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) AS objectcode,
        'PICK' AS type, cm.event_dttm AS dt, u2.dwc_id::varchar AS user_id,
        rd.DETAILID, rd.RECEIPTSDETAILID, entity_content_quantity AS qty,
        id.DETAILQUANTITY AS detail_qty, id.DETAILPRICEBUY AS detail_price,
        NULL AS HOSTNAME, substring(object_from, position('(' IN object_from) + 1) AS object_from,
        substring(object_to, position('(' IN object_to) + 1) AS object_to,
        cm.CELLFROM_CODE AS loc_from, cm.CELLTO_CODE AS loc_to,
        CASE WHEN rd.BITBIG = TRUE THEN 'BIG' WHEN rd.SORTTYPEID = 1 THEN 'SMALL' WHEN rd.SORTTYPEID IN (2,3) THEN 'NORMAL' END AS ITEM_TYPE,
        left(cm.destination, 4) AS customerlogo, NULL AS customername, NULL AS orderid,
        right(cm.destination, 4) AS destinationlogo, sup.SUPPLIERLOGO,
        i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM cm_parcel cm
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd ON substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) = concat(rd.orderdetailsubid, '_', rd.portion)
    LEFT JOIN user_mapping u2 ON cm.user_id = u2.user_id
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE cm.operation = 'picking' AND cm.entity_subtype = 'Parcel' AND cm.PARENT_ID IS NOT NULL
      AND cm.object_to NOT LIKE 'TR_%' AND cm.event_dttm >= ${innerDateCond} AND u2.dwc_id != 44
    GROUP BY ALL
),
ops_dwc_combined AS (
    SELECT objectcode,type,dt,user_id,DETAILID,RECEIPTSDETAILID,qty,detail_qty,detail_price,HOSTNAME,object_from,object_to,loc_from,loc_to,item_type,customerlogo,CUSTOMERNAME,orderid,destinationlogo,SUPPLIERLOGO,invoicenumber,Invoice_Receipt_DT FROM wh_ops
    UNION ALL SELECT objectcode,type,dt,user_id,DETAILID,RECEIPTSDETAILID,qty,detail_qty,detail_price,HOSTNAME,object_from,object_to,loc_from,loc_to,ITEM_TYPE,customerlogo,customername,orderid,destinationlogo,SUPPLIERLOGO,invoicenumber,Invoice_Receipt_DT FROM pc_ops
    UNION ALL SELECT objectcode,type,dt,user_id,DETAILID,RECEIPTSDETAILID,qty,detail_qty,detail_price,HOSTNAME,object_from,object_to,loc_from,loc_to,ITEM_TYPE,customerlogo,customername,orderid,destinationlogo,SUPPLIERLOGO,invoicenumber,Invoice_Receipt_DT FROM pc_sm_ops
    UNION ALL SELECT objectcode,type,dt,user_id,DETAILID,RECEIPTSDETAILID,qty,detail_qty,detail_price,HOSTNAME,object_from,object_to,loc_from,loc_to,item_type,customerlogo,CUSTOMERNAME,orderid,destinationlogo,SUPPLIERLOGO,invoicenumber,Invoice_Receipt_DT FROM rc_ops
),
ops_si AS (
    SELECT objectcode,
        CASE WHEN type = 'READY' THEN 'PLACE' WHEN type = 'SORTING' THEN 'SORT' WHEN type = 'PACKING' THEN 'PACK' WHEN type = 'REPACKING' THEN 'REPACK' ELSE type END AS TYPE,
        DT,USER_ID,DETAILID,RECEIPTSDETAILID,qty,detail_qty,detail_price,HOSTNAME,object_from,object_to,loc_from,loc_to,
        LAST_VALUE(ITEM_TYPE IGNORE NULLS) OVER (PARTITION BY objectcode ORDER BY DT DESC, type ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS ITEM_TYPE,
        customerlogo,CUSTOMERNAME,orderid,destinationlogo,SUPPLIERLOGO,invoicenumber,Invoice_Receipt_DT
    FROM ops_dwc_combined WHERE USER_ID != '44'
),
box_customers AS (
    SELECT box_id, BOX_CUSTOMER_LOGO AS customerlogo, BOX_DESTINATION_LOGO AS destinationlogo
    FROM DWH.EMART.DWC_EXPEDITION_BOXESTRANSIT_AND_SHIPMENT
),
ops_box AS (
    SELECT bt.BOX_ID::varchar AS objectcode,
        CASE WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.closed' THEN 'PACK_NEW_BOX'
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.sorted' THEN 'CARGO_PLACE'
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.picked' THEN 'CARGO_PICK'
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.taken' THEN 'CARGO_SHIP'
        END AS type,
        bt.EVENT_DTTM AS dt, bt.USER_ID::varchar AS USER_ID,
        NULL AS DETAILID, NULL AS RECEIPTSDETAILID, NULL AS qty, NULL AS detail_qty, NULL AS detail_price,
        bt.place_id AS HOSTNAME, NULL AS object_from, NULL AS object_to,
        NULL AS loc_from, bt.place_id AS loc_to, 'BOX' AS ITEM_TYPE,
        bc.customerlogo, NULL AS CUSTOMERNAME, NULL AS orderid,
        bc.destinationlogo, NULL AS SUPPLIERLOGO, NULL AS invoicenumber, NULL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_DWC.V_DWC_EXPEDITION_BOXESTRANSIT bt
    LEFT JOIN box_customers bc ON bt.box_id = bc.box_id
    WHERE EVENT_DTTM >= ${innerDateCond} AND USER_ID != 44
    UNION ALL
    SELECT substring(entity_barcode, position('(' IN entity_barcode) + 1) AS objectcode,
        'PICK_BOX' AS type, cm.event_dttm AS dt, u2.dwc_id::varchar AS user_id,
        NULL AS DETAILID, NULL AS RECEIPTSDETAILID, NULL AS qty, NULL AS detail_qty, NULL AS detail_price,
        NULL AS HOSTNAME, NULL AS object_from, NULL AS object_to,
        cm.CELLFROM_CODE AS loc_from, cm.CELLTO_CODE AS loc_to, 'BOX' AS ITEM_TYPE,
        bc.customerlogo, NULL AS CUSTOMERNAME, NULL AS orderid,
        bc.destinationlogo, NULL AS SUPPLIERLOGO, NULL AS invoicenumber, NULL AS Invoice_Receipt_DT
    FROM cm_parcel cm
    LEFT JOIN box_customers bc ON substring(entity_barcode, position('(' IN entity_barcode) + 1) = bc.box_id
    LEFT JOIN user_mapping u2 ON cm.user_id = u2.user_id
    WHERE cm.operation = 'picking' AND cm.entity_subtype = 'Box' AND cm.PARENT_ID IS NOT NULL
      AND cm.object_to LIKE 'TR_%' AND cm.event_dttm >= ${innerDateCond} AND u2.dwc_id != 44
),
det_lookup AS (
    SELECT d.detailnum, m.makelogo, m.makename, d.detailid, d.detailnamerus, d.detailname
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.DETAILS d
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.MAKES m ON d.makeid = m.makeid
),
inb AS (
    SELECT CASE WHEN left(barcode, 1) = '*' OR left(barcode, 1) = '!' THEN replace(substring(ind.barcode, 6), '/', '_')
        ELSE substring(barcode, position('(' IN barcode) + 1) END AS objectcode,
        ind.portioncode, ind.quantity, det_lookup.detailid, ind.inbound_detail_id, inh.inbound_id,
        substring(inh.code, 10) AS code, inh.supplier_code
    FROM DWH.REPLICA_VDOCKERPSQL1_EMEXUAE.V_LKP_DOCUMENTS_INBOUND_DETAILS ind
    LEFT JOIN det_lookup ON ind.detailnumber = det_lookup.detailnum AND ind.makename = det_lookup.makename
    LEFT JOIN DWH.REPLICA_VDOCKERPSQL1_EMEXUAE.V_LKP_DOCUMENTS_INBOUND_HEADS inh ON ind.inbound_id = inh.inbound_id
    WHERE ind.state_date >= ${innerDateCond} AND left(inh.code, 3) = 'DWC'
),
stoc_invoices AS (
    SELECT si.invoiceid, sid.invoicesdetailid, sid.orderdetailsubid, sid.quantityscan, si.invoicenumber
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.STOCINVOICES si
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.STOCINVOICESDETAILS sid ON si.invoiceid = sid.invoiceid
),
ops_stoc AS (
    SELECT CASE WHEN left(inb.objectcode, 3) = 'STK' THEN replace(substr(inb.objectcode, 4), '/', '_') ELSE inb.objectcode::varchar END AS objectcode,
        CASE WHEN OPERATIONID=1 THEN 'STOCK_RECEIPTING' WHEN OPERATIONID=2 THEN 'STOCK_PLACE' WHEN OPERATIONID=4 THEN 'STOCK_PICK' WHEN OPERATIONID=5 THEN 'STOCK_INVENTORY' ELSE 'UNKNOWN' END AS type,
        EVENTTIME AS dt, sol.USERID::varchar AS USER_ID, inb.detailid AS DETAILID, NULL AS RECEIPTSDETAILID,
        inb.quantity AS qty, NULL AS detail_qty, NULL AS detail_price, NULL AS HOSTNAME,
        sol.placeid::varchar AS object_from, NULL AS object_to, NULL AS loc_from, NULL AS loc_to, 'STOCK' AS ITEM_TYPE,
        NULL AS customerlogo, NULL AS CUSTOMERNAME, NULL AS orderid,
        NULL AS destinationlogo, inb.supplier_code AS SUPPLIERLOGO,
        s.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.V_TBL_STOCOPERATIONLOG sol
    LEFT JOIN inb ON sol.objectid = inb.inbound_detail_id
    LEFT JOIN stoc_invoices s ON inb.code = s.invoiceid AND inb.portioncode = s.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON inb.supplier_code = sup.suppliercode
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON s.invoiceid = i.invoiceid
    WHERE EVENTTIME >= ${innerDateCond} AND sol.USERID != 44
),
fdata AS (
    SELECT * FROM ops_stoc UNION ALL SELECT * FROM ops_si UNION ALL SELECT * FROM ops_box
),
SOURCE_DWC AS (
    SELECT f.OBJECTCODE, split_part(f.OBJECTCODE, '_', 1) AS sub_id, f.TYPE,
        CASE WHEN TYPE='RECEIPTING' THEN 0 WHEN TYPE='SORT' THEN 1 WHEN TYPE='PLACE' THEN 2 WHEN TYPE='PICK' THEN 3 WHEN TYPE='PACK' THEN 4 END AS TYPE_NUM,
        f.DT, WEEKOFYEAR(f.DT) AS week_num,
        lag(f.dt) OVER (PARTITION BY f.USER_ID ORDER BY f.dt) AS prev_dt,
        datediff(second, prev_dt, f.DT) AS ops_time,
        f.USER_ID, u3.username, f.DETAILID, f.RECEIPTSDETAILID, f.qty, f.qty AS qty2, f.detail_qty, f.detail_price,
        det_lookup.detailnum, coalesce(det_lookup.detailnamerus, det_lookup.detailname) AS descr,
        f.HOSTNAME, f.object_from, f.object_to, f.loc_from, f.loc_to,
        f.ITEM_TYPE, f.customerlogo, f.CUSTOMERNAME, f.orderid,
        f.destinationlogo, f.SUPPLIERLOGO, det_lookup.makelogo, det_lookup.MAKENAME,
        invoicenumber, Invoice_Receipt_DT
    FROM fdata f
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.USERS u3 ON f.USER_ID = u3.userid
    LEFT JOIN det_lookup ON f.detailid = det_lookup.detailid
    WHERE NOT (item_type = 'BIG' AND f.TYPE = 'SORT') AND NOT (item_type = 'BIG' AND f.TYPE = 'REPACK') AND f.USER_ID != '44'
),
dwc_receipt_problems_agg AS (
    SELECT objectcode,
        MAX(CASE WHEN defect_flag = 'd18' THEN 1 ELSE 0 END) AS rp_d18,
        MAX(CASE WHEN defect_flag = 'd21' THEN 1 ELSE 0 END) AS rp_d21,
        MAX(CASE WHEN defect_flag = 'd22' THEN 1 ELSE 0 END) AS rp_d22,
        MAX(CASE WHEN defect_flag = 'd24' THEN 1 ELSE 0 END) AS rp_d24,
        MAX(CASE WHEN defect_flag = 'd25' THEN 1 ELSE 0 END) AS rp_d25
    FROM (
        SELECT CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
            CASE WHEN p.ID IN (4,6,7) THEN 'd21' WHEN p.ID = 10 THEN 'd22' WHEN p.ID IN (8,9,2) THEN 'd24' WHEN p.ID IN (1,3,11) THEN 'd25' WHEN p.ID = 17 THEN 'd18' END AS defect_flag
        FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
        JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM_LINK l ON rd.RECEIPTSDETAILID = l.RECEIPTSDETAILID
        JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM p ON l.PROBLEMID = p.ID
        WHERE rd.DELETED_FLG = FALSE AND p.DELETED_FLG = FALSE AND p.ID NOT IN (-1,-4)
    ) GROUP BY objectcode
),
defect_data AS (
    SELECT dd.RECEIPTSDETAILID, dd.DEFECTDATE, dd.DETAILQUANTITY,
        CASE WHEN dd.DEFECTREASONID = 8 THEN 1 ELSE 0 END AS is_damaged,
        CASE WHEN dd.DEFECTREASONID = 25 THEN 1 ELSE 0 END AS is_barcode,
        CASE WHEN dd.DEFECTREASONID = 9 THEN 1 ELSE 0 END AS is_shortage,
        CASE WHEN dd.DEFECTREASONID = 16 THEN 1 ELSE 0 END AS is_refusal,
        CASE WHEN dd.DEFECTREASONID = 20 THEN 1 ELSE 0 END AS is_lost
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.DEFECTSDETAILS dd
    WHERE dd.DELETED_FLG = FALSE AND dd.DEFECTREASONID IN (8,25,9,16,20)
),
defect_agg AS (
    SELECT RECEIPTSDETAILID, MAX(DETAILQUANTITY) AS claim_ct,
        MAX(is_damaged) AS is_damaged, MAX(is_barcode) AS is_barcode,
        MAX(is_shortage) AS is_shortage, MAX(is_refusal) AS is_refusal,
        MAX(is_lost) AS is_lost, MAX(CASE WHEN is_lost = 1 THEN DEFECTDATE END) AS lost_dt
    FROM defect_data GROUP BY RECEIPTSDETAILID
),
stage_dates AS (
    SELECT OBJECTCODE,
        MAX(CASE WHEN TYPE = 'RECEIPTING' THEN DT END) AS receipt_dt,
        MAX(CASE WHEN TYPE = 'PLACE' THEN DT END) AS place_dt,
        MAX(CASE WHEN TYPE = 'PICK' THEN DT END) AS pick_dt,
        MAX(CASE WHEN TYPE = 'PACK' THEN DT END) AS pack_dt,
        MAX(ITEM_TYPE) AS item_type, MAX(descr) AS detailname, MAX(detailnum) AS detailnum,
        MAX(makelogo) AS makelogo, MAX(MAKENAME) AS makename, MAX(CUSTOMERNAME) AS customername,
        MAX(customerlogo) AS customerlogo, MAX(orderid) AS orderid, MAX(destinationlogo) AS destinationlogo,
        MAX(SUPPLIERLOGO) AS supplierlogo, MAX(invoicenumber) AS invoicenumber,
        MAX(Invoice_Receipt_DT) AS invoice_receipt_dt, MAX(username) AS employee_name,
        MAX(USER_ID) AS employee_id, MAX(DETAILID) AS detailid, MAX(RECEIPTSDETAILID) AS receiptsdetailid,
        MAX(detail_qty) AS _qty, MAX(detail_price) AS _price,
        MAX(HOSTNAME) AS workstation, MAX(loc_from) AS loc_from, MAX(loc_to) AS loc_to,
        MAX(object_from) AS object_from, MAX(object_to) AS object_to
    FROM SOURCE_DWC WHERE ITEM_TYPE != 'BOX' GROUP BY OBJECTCODE
),
dwc_defect_flags AS (
    SELECT s.*,
        COALESCE(rp.rp_d18, 0) AS d18,
        GREATEST(COALESCE(da.is_damaged, 0), COALESCE(rp.rp_d21, 0)) AS d21,
        GREATEST(COALESCE(da.is_barcode, 0), COALESCE(rp.rp_d22, 0)) AS d22,
        COALESCE(da.is_shortage, 0) AS d23,
        GREATEST(COALESCE(da.is_refusal, 0), COALESCE(rp.rp_d24, 0)) AS d24,
        COALESCE(rp.rp_d25, 0) AS d25,
        COALESCE(da.is_lost, 0) AS d_lost,
        CASE WHEN s.receipt_dt IS NOT NULL AND s.place_dt IS NULL AND DATEDIFF('day', s.receipt_dt, CURRENT_DATE()) >= 30 THEN 1 ELSE 0 END AS d_stuck_place,
        CASE WHEN s.pick_dt IS NOT NULL AND s.pack_dt IS NULL AND DATEDIFF('day', s.pick_dt, CURRENT_DATE()) >= 30 THEN 1 ELSE 0 END AS d_stuck_pick,
        CASE WHEN s.pack_dt IS NOT NULL AND DATEDIFF('day', s.pack_dt, CURRENT_DATE()) >= 30 THEN 1 ELSE 0 END AS d_stuck_pack,
        da.lost_dt, da.claim_ct
    FROM stage_dates s
    LEFT JOIN defect_agg da ON s.receiptsdetailid = da.RECEIPTSDETAILID
    LEFT JOIN dwc_receipt_problems_agg rp ON s.OBJECTCODE = rp.objectcode
),
dwc_d AS (
    SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage, 'Error' AS d_type, 'Повреждение' AS problem_code FROM dwc_defect_flags WHERE d21 = 1
    UNION ALL SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage, 'Error' AS d_type, 'Без маркировки' AS problem_code FROM dwc_defect_flags WHERE d22 = 1
    UNION ALL SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage, 'Error' AS d_type, 'Недостача' AS problem_code FROM dwc_defect_flags WHERE d23 = 1
    UNION ALL SELECT *, COALESCE(lost_dt, receipt_dt) AS income_dt, 'RECEIPTING' AS stage, 'Lost' AS d_type, 'Потери' AS problem_code FROM dwc_defect_flags WHERE d_lost = 1
),
SOURCE_DWC_DETAIL AS (
    SELECT OBJECTCODE, item_type, detailname, detailnum, makename,
        DATE_TRUNC('HOUR', income_dt) AS "ДатаВремя", DATE_TRUNC('DAY', income_dt) AS "День",
        DATEADD('DAY', -(DAYOFWEEKISO(income_dt) - 1), DATE_TRUNC('DAY', income_dt)) AS "Неделя",
        DATE_PART('HOUR', income_dt) AS "Час",
        stage, employee_name, employee_id, d_type, problem_code,
        workstation, loc_from, loc_to, object_from, object_to,
        claim_ct::number AS claim_ct, _qty AS claim_qty, _price AS claim_price,
        'DWC' AS sklad, 'EMEX' AS storerkey
    FROM dwc_d
),
dwc_supplier_receipt_defects AS (
    SELECT "ДатаВремя","День","Неделя","Час",
        CASE WHEN "Час" BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        CASE WHEN stage = 'RECEIPTING' THEN 'Приемка' WHEN stage = 'PICK' THEN 'Подбор' WHEN stage = 'PLACE' THEN 'Размещение'
            WHEN stage = 'SORT' THEN 'Сортировка' WHEN stage = 'PACK' THEN 'Упаковка' ELSE 'Неизвестно' END AS "Этап",
        CASE WHEN problem_code IN ('Повреждение','Без маркировки') THEN 'По качеству'
            WHEN problem_code IN ('Недостача','Потери','Зависший товар') THEN 'По количеству' ELSE problem_code END AS "Категория отклонения",
        CASE WHEN problem_code = 'Повреждение' THEN 'повреждение' WHEN problem_code = 'Без маркировки' THEN 'повреждение упаковки'
            WHEN problem_code = 'Недостача' THEN 'недостача' WHEN problem_code = 'Потери' THEN 'недостача'
            WHEN problem_code = 'Зависший товар' THEN 'недостача 30д' ELSE problem_code END AS "Отклонение",
        "Отклонение" AS "Отклонение из источника",
        'DWC' AS "Склад", 'EMEX' AS "Заказчик", 'Поставщик' AS "Виновник",
        claim_ct AS claim_ct, claim_qty AS claim_qty,
        COALESCE(claim_price, 0) * COALESCE(claim_ct, claim_qty, 1) AS claim_amount,
        employee_name AS "USER", detailname AS "Наименование", item_type AS "Тип товара"
    FROM SOURCE_DWC_DETAIL
),
receipt_problems AS (
    SELECT CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        p.ID AS problem_id, l.CREATEDATE::timestamp_ntz AS createdate, p.SHORTNAME,
        CASE WHEN p.ID IN (4, 6, 7) THEN 'd21' WHEN p.ID = 10 THEN 'd22' END AS defect_flag
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM_LINK l ON rd.RECEIPTSDETAILID = l.RECEIPTSDETAILID
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM p ON l.PROBLEMID = p.ID
    WHERE rd.DELETED_FLG = FALSE AND p.DELETED_FLG = FALSE AND rd.RECEIPTSDETAILSDATE >= ${innerDateCond} AND p.ID IN (4,6,7,10)
),
ops_dwc_raw AS (
    SELECT * FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC
    WHERE SOURCE = 'DWC' AND OPERATION_DT >= DATEADD('day', -30, ${innerDateCondTsNtz}) AND CUSTOMERNAME NOT IN ('QEEE', 'EMEX')
),
ops_dwc_enriched AS (
    SELECT o.*,
        LAG(o.TYPE) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_type,
        LAG(o.USERNAME) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_username,
        LAG(o.USER_ID) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_userid,
        LAG(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_op_dt,
        CASE WHEN LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) IS NULL THEN current_date()
        ELSE LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) END AS next_op_dt,
        LEAD(o.TYPE) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS next_type
    FROM ops_dwc_raw o
),
dwc_defect_actor AS (
    SELECT rp.objectcode, rp.problem_id, rp.defect_flag, rp.createdate,
        o.prev_op_dt AS defect_op_dt, o.prev_type AS defect_stage_type,
        o.prev_userid AS defect_user_id, o.prev_username AS defect_user,
        o.CUSTOMERNAME, o.DETAILNAME, o.ITEM_TYPE,
        COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_qty,
        COALESCE(o.DETAILPRICEBUY, 0) * COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_amount
    FROM receipt_problems rp
    JOIN ops_dwc_enriched o ON o.OBJECTCODE = rp.objectcode AND o.OPERATION_DT < rp.createdate AND o.OPERATION_DT >= DATEADD('day', -1, rp.createdate)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY rp.objectcode, rp.problem_id, rp.createdate ORDER BY o.OPERATION_DT DESC) = 1
),
dwc_receipt_defects_prepared AS (
    SELECT createdate AS "ДатаВремя", DATE_TRUNC('day', createdate) AS "День",
        DATEADD('day', -(DAYOFWEEKISO(createdate) - 1), DATE_TRUNC('day', createdate)) AS "Неделя",
        DATE_PART('hour', createdate) AS "Час",
        CASE WHEN DATE_PART('hour', createdate) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        CASE
            WHEN defect_stage_type IN ('RECEIPTING','STOCK_RECEIPTING') THEN 'Приемка'
            WHEN defect_stage_type IN ('PICK','STOCK_PICK','STOCK_PICKING') THEN 'Подбор'
            WHEN defect_stage_type = 'PLACE' THEN 'Размещение'
            WHEN defect_stage_type IN ('SORT','PRESORTING') THEN 'Сортировка'
            WHEN defect_stage_type IN ('PACK','REPACK') THEN 'Упаковка'
            WHEN defect_stage_type IN ('EXPERT','EXPERTISE') THEN 'Экспертиза'
            ELSE defect_stage_type
        END AS "Этап",
        CASE WHEN defect_flag = 'd21' THEN 'По качеству' WHEN defect_flag = 'd22' THEN 'По количеству' ELSE 'Неизвестно' END AS "Категория отклонения",
        CASE WHEN defect_flag = 'd21' THEN 'повреждение' WHEN defect_flag = 'd22' THEN 'недостача' ELSE 'Неизвестно' END AS "Отклонение",
        "Отклонение" AS "Отклонение из источника",
        'DWC' AS "Склад", COALESCE(CUSTOMERNAME,'EMEX') AS "Заказчик",
        'Склад' AS "Виновник",
        1 AS claim_ct, claim_qty, claim_amount,
        COALESCE(defect_user, 'UNKNOWN') AS "USER", DETAILNAME AS "Наименование", ITEM_TYPE AS "Тип товара"
    FROM dwc_defect_actor WHERE defect_stage_type IS NOT NULL
),
dwc_time_defect_events AS (
    SELECT DATEADD('day', 30, o.OPERATION_DT) AS "ДатаВремя",
        DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT)) AS "День",
        DATEADD('day', -(DAYOFWEEKISO(DATEADD('day', 30, o.OPERATION_DT)) - 1), DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT))) AS "Неделя",
        DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) AS "Час",
        CASE WHEN DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        CASE
            WHEN o.TYPE IN ('RECEIPTING','STOCK_RECEIPTING') THEN 'Приемка'
            WHEN o.TYPE IN ('PICK','STOCK_PICK','STOCK_PICKING','PICK_BOX') THEN 'Подбор'
            WHEN o.TYPE IN ('PLACE','STOCK_PLACE') THEN 'Размещение'
            WHEN o.TYPE IN ('SORT','PRESORTING') THEN 'Сортировка'
            WHEN o.TYPE IN ('PACK','REPACK','PACK_NEW_BOX') THEN 'Упаковка'
            WHEN o.TYPE IN ('EXPERT','EXPERTISE') THEN 'Экспертиза'
            WHEN o.TYPE IN ('CARGO_PLACE','CARGO_PICK','CARGO_SHIP') THEN 'Отгрузка'
            ELSE o.TYPE
        END AS "Этап",
        'По количеству' AS "Категория отклонения", 'Не было движений 30+ дней' AS "Отклонение",
        'Не было движений 30+ дней' AS "Отклонение из источника",
        'DWC' AS "Склад", COALESCE(o.CUSTOMERNAME,'EMEX') AS "Заказчик",
        'Склад' AS "Виновник",
        1 AS claim_ct, COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_qty,
        COALESCE(o.DETAILPRICEBUY, 0) * COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_amount,
        COALESCE(o.USERNAME, 'UNKNOWN') AS "USER", o.DETAILNAME AS "Наименование", o.ITEM_TYPE AS "Тип товара"
    FROM ops_dwc_enriched o
    WHERE o.next_op_dt IS NOT NULL AND DATEDIFF('day', o.OPERATION_DT, o.next_op_dt) >= 30
      AND o.TYPE NOT IN ('CARGO_PLACE','PLACE','PACK','REPACK','PACK_NEW_BOX','STOCK_PLACE','CARGO_SHIP','EXPERT','EXPERTISE')
      AND DATEADD('day', 30, o.OPERATION_DT) >= ${innerDateCondTsNtz}
),
dwc_all_defects AS (
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_ct,claim_qty,claim_amount,"USER","Наименование","Тип товара" FROM dwc_receipt_defects_prepared
    UNION ALL
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_ct,claim_qty,claim_amount,"USER","Наименование","Тип товара" FROM dwc_time_defect_events
    UNION ALL
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","Виновник",claim_ct,claim_qty,claim_amount,"USER","Наименование","Тип товара" FROM dwc_supplier_receipt_defects
),
dwc_union AS (
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик",
        SUM(claim_ct) AS "Количество отклонений",
        SUM(claim_qty) AS "Кол-во шт в отклонении",
        SUM(claim_amount) AS "Сумма в руб. отклонений",
        "USER","Наименование","Тип товара","Виновник"
    FROM dwc_all_defects
    GROUP BY "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Отклонение из источника","Склад","Заказчик","USER","Наименование","Тип товара","Виновник"
),
all_defects_final AS (
    SELECT * FROM BD_UNION
    UNION ALL SELECT * FROM kdz_union
    UNION ALL SELECT * FROM dwc_union
)
`;
}

export const SF_COL_MAP: Record<string, string> = {
  "ДатаВремя": "datetime",
  "День": "day",
  "Неделя": "week",
  "Час": "hour",
  "Смена": "shift",
  "Этап": "stage",
  "Категория отклонения": "deviation_category",
  "Отклонение": "deviation",
  "Отклонение из источника": "deviation_source",
  "Склад": "warehouse",
  "Заказчик": "customer",
  "Количество отклонений": "deviation_count",
  "Кол-во шт в отклонении": "quantity",
  "Сумма в руб. отклонений": "amount_rub",
  "USER": "employee",
  "user": "employee",
  "Наименование": "product_name",
  "Тип товара": "item_type",
  "Виновник": "blame",
};

export function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const newKey = SF_COL_MAP[key] || key;
    mapped[newKey] = value;
  }
  if (mapped.datetime instanceof Date) mapped.datetime = mapped.datetime.toISOString().replace("T", " ").split(".")[0];
  if (mapped.day instanceof Date) mapped.day = mapped.day.toISOString().split("T")[0];
  if (mapped.week instanceof Date) mapped.week = mapped.week.toISOString().split("T")[0];
  return mapped;
}
