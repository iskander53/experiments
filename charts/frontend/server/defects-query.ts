/**
 * Builds the full defects SQL query (BD + KDZ + DWC unions) with date/warehouse filters.
 * Returns as a CTE-wrapped query that can be aggregated or filtered further.
 */
export function buildDefectsCTE(dateFrom: string, dateTo?: string): string {
  const dateFilter = dateTo
    ? `'${dateFrom}' AND "ДатаВремя" < '${dateTo}'`
    : `'${dateFrom}'`;

  // The date condition used in inner CTEs for limiting scans
  const innerDateCond = `'${dateFrom}'`;

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
p AS (
    SELECT u.name, u.zup, o.sku, o.event_dttm
    FROM DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
    LEFT JOIN u ON o.user = u.login
    WHERE o.EVENT_TYPE = 'CARGO_PACK' AND o.event_dttm >= '2025-10-01'
    QUALIFY rank() OVER (PARTITION BY o.sku ORDER BY o.event_id DESC) = 1
),
cs AS (
    SELECT u.name, u.zup, o.sku, o.event_dttm
    FROM DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
    LEFT JOIN u ON o.user = u.login
    WHERE o.EVENT_TYPE = 'CARGO_SHIP' AND o.event_dttm >= '2025-10-01'
    QUALIFY rank() OVER (PARTITION BY o.sku ORDER BY o.event_id DESC) = 1
),
gm AS (
    SELECT detail_article, max(EVENT_DTTM) as dt
    FROM DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_EXPECTED_GOODS_ARRIVAL_TOMILINO_GOODS
    GROUP BY detail_article
),
n AS (
    SELECT detail_article, code::varchar as code, uuid, GOODS_TYPE
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
    SELECT max(g.UNIT_PRICE) as price, n.code as sku
    FROM DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_EXPECTED_GOODS_ARRIVAL_TOMILINO_GOODS as g
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
            ELSE ec.problem_code
        END AS "Категория отклонения",
        CASE
            WHEN ec.problem_code = 'Излишки' THEN 'излишек'
            WHEN ec.problem_code IN ('Недостача ГМ', 'Недостача') THEN 'недостача'
            WHEN ec.problem_code IN ('Заводской брак','Механические повреждения','Некомплект') THEN 'повреждение'
            ELSE ec.problem_code
        END AS "Отклонение",
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
        concat(
            CASE WHEN "Этап" = 'Упаковка' THEN p.zup WHEN "Этап" = 'Отгрузка ГМ' THEN cs.zup END,
            ' ',
            CASE WHEN "Этап" = 'Упаковка' THEN p.name WHEN "Этап" = 'Отгрузка ГМ' THEN cs.name END
        ) AS user,
        ec.detail_num AS "Наименование",
        s.TYPE AS "Тип товара"
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
    GROUP BY "ДатаВремя","Этап","Категория отклонения","Отклонение","Склад","Заказчик",user,ec.detail_num,s.TYPE
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
        CASE WHEN ops.warehouse_code IN ('K41','К41') THEN 'BD1' WHEN ops.warehouse_code IN ('K40','К40') THEN 'KBD' ELSE ops.warehouse_code END AS "Склад",
        ops.storer AS "Заказчик", 1 AS "Количество отклонений", ops.sku_cnt AS "Кол-во шт в отклонении",
        ops.sku_cnt * pr.price AS "Сумма в руб. отклонений",
        COALESCE(concat(u.zup,' ',u.name), ops.prev_user) AS user,
        ops.sku_nm AS "Наименование", 'BOX' AS "Тип товара"
    FROM ops LEFT JOIN prices AS pr ON ops.sku = pr.sku LEFT JOIN u ON ops.prev_user = u.login
    WHERE ops.defect30flag = 1 AND "ДатаВремя" >= ${innerDateCond}
      AND ops.EVENT_TYPE ILIKE '%cargo%' AND ops.sku_nm != 'NONE'
),
departure_dttm AS(
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
                d.PLANNED_TOM_DEPARTURE_DTTM, d.PLANNED_BD_DEPARTURE_DTTM,
                d.PLANNED_DZE_DEPARTURE_DTTM, d.PLANNED_DEPARTURE_DTTM,
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
ops_dz AS (
    SELECT *, LAG(USER_ID) OVER (PARTITION BY OBJECTCODE ORDER BY OPERATION_DT) AS prev_user
    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC
    WHERE SOURCE = 'KDZ' AND OPERATION_DT >= '2025-11-01'
    QUALIFY row_number() OVER (PARTITION BY type, OBJECTKEY ORDER BY OPERATION_DT DESC) = 1
),
gm_not_first_voyage AS (
    SELECT f.dt AS "ДатаВремя", f.Day AS "День", f.W AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        'Отгрузка ГМ' AS "Этап", 'По времени' AS "Категория отклонения", 'Опоздание' AS "Отклонение",
        f.wh AS "Склад", ska.storerkey AS "Заказчик", 1 AS "Количество отклонений",
        CASE WHEN f.wh != 'KDZ' THEN sum(pd.qty) ELSE sum(rd.DETAILQUANTITY) END AS "Кол-во шт в отклонении",
        0 AS "Сумма в руб. отклонений",
        CASE WHEN f.wh != 'KDZ' THEN COALESCE(concat(u.zup,' ',u.name), o.prev_user)
            ELSE COALESCE(concat(udz.TABNUMBER,' ',udz.USERNAME), dz.prev_user)
        END AS user,
        f.dropid AS "Наименование", 'BOX' AS "Тип товара"
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
lost AS (
    SELECT event_dttm AS "ДатаВремя", event_dttm::date AS "День", date_trunc(week, event_dttm) AS "Неделя",
        extract(hour FROM "ДатаВремя") AS "Час",
        CASE WHEN "Час" >= 8 AND "Час" <= 20 THEN 1 ELSE 2 END AS "Смена",
        'Хранение' AS "Этап",
        CASE WHEN cell_to ILIKE '%lost%' OR cell_to ILIKE '%karant%' THEN 'По количеству' ELSE 'По качеству' END AS "Категория отклонения",
        CASE WHEN cell_to ILIKE '%lost%' THEN 'недостача' WHEN cell_to ILIKE '%karant%' THEN 'излишек' ELSE 'повреждение' END AS "Отклонение",
        warehouse_code AS "Склад", storer AS "Заказчик", 1 AS "Количество отклонений",
        sku_cnt AS "Кол-во шт в отклонении", o.sku_cnt * pr.price AS "Сумма в руб. отклонений",
        COALESCE(concat(u.zup,' ',u.name), o.prev_user) AS user,
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
        END AS "Тип товара"
    FROM ops o LEFT JOIN prices AS pr ON o.sku = pr.sku LEFT JOIN u ON o.prev_user = u.login
    WHERE 1=1 AND (cell_to ILIKE '%lost%' OR cell_to ILIKE '%bra%' OR cell_to ILIKE '%rack%' OR cell_to ILIKE '%karant%') AND sku_cnt > 0
),
defects_bd AS (
    SELECT DISTINCT * FROM lost
    UNION ALL SELECT DISTINCT * FROM reklamacii
    UNION ALL SELECT DISTINCT * FROM gm_not_first_voyage
    UNION ALL SELECT DISTINCT * FROM defects30days
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
            WHEN o.TYPE = 'UNKNOWN' THEN 'Неизвестно'
            WHEN o.TYPE IN ('CARGO_PLACE','CARGO_PICK','CARGO_SHIP') THEN 'Отгрузка'
            ELSE COALESCE(o.TYPE, 'Неизвестно')
        END AS stage_curr
    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC o
    WHERE o.OPERATION_DT >= DATEADD('day', -30, ${innerDateCond}::timestamp)
      AND o.SOURCE = 'KDZ'
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
            ELSE COALESCE(o.prev_type, 'Неизвестно')
        END AS "Этап",
        'По количеству' AS "Категория отклонения", 'недостача' AS "Отклонение",
        'KDZ' AS "Склад", COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        o.qty_eff AS claim_qty, COALESCE(o.price_eff, 0) AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,
        COALESCE(o.prev_username, o.USERNAME) AS "USER",
        o.DETAILNAME AS "Наименование", o.ITEM_TYPE AS "Тип товара", o.OBJECTCODE
    FROM kdz_ops_all o
    WHERE o.TOPLACECODE IN ('888888', 'LOST') AND o.OPERATION_DT >= ${innerDateCond}::timestamp AND o.prev_type IS NOT NULL
),
kdz_time_defect_events AS (
    SELECT DATEADD('day', 30, o.OPERATION_DT) AS "ДатаВремя",
        DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT))::date AS "День",
        DATEADD('day', -(DAYOFWEEKISO(DATEADD('day', 30, o.OPERATION_DT)) - 1), DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT)))::date AS "Неделя",
        DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) AS "Час",
        CASE WHEN DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        o.stage_curr AS "Этап", 'По количеству' AS "Категория отклонения", 'Не было движений 30+ дней' AS "Отклонение",
        'KDZ' AS "Склад", COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        o.qty_eff AS claim_qty, COALESCE(o.price_eff, 0) AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,
        o.USERNAME AS "USER", o.DETAILNAME AS "Наименование", o.ITEM_TYPE AS "Тип товара", o.OBJECTCODE
    FROM kdz_ops_gaps o
    WHERE 1=1 AND DATEDIFF('day', o.OPERATION_DT, o.next_op_dt) >= 30
      AND DATEADD('day', 30, o.OPERATION_DT) >= ${innerDateCond}::timestamp
      AND o.TYPE NOT IN ('BOX_PLACE','PICK','STOCK_PICK','STOCK_PICKING','PLACE','CARGO_SHIP','STOCK_INVENTORY','STOCK_PLACE')
),
all_defects_kdz AS (
    SELECT * FROM kdz_defect_events UNION ALL SELECT * FROM kdz_time_defect_events
),
kdz_union AS (
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение",
        "Склад","Заказчик", COUNT(DISTINCT OBJECTCODE) AS "Количество отклонений",
        SUM(claim_qty) AS "Кол-во шт в отклонении", SUM(claim_amount) AS "Сумма в руб. отклонений",
        "USER","Наименование","Тип товара"
    FROM all_defects_kdz GROUP BY "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Склад","Заказчик","USER","Наименование","Тип товара"
),

receipt_problems AS (
    SELECT CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode, p.ID AS problem_id,
        l.CREATEDATE::timestamp_ntz AS createdate, p.SHORTNAME,
        CASE WHEN p.ID IN (4, 6, 7) THEN 'd21' WHEN p.ID = 10 THEN 'd22' END AS defect_flag
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM_LINK l ON rd.RECEIPTSDETAILID = l.RECEIPTSDETAILID
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM p ON l.PROBLEMID = p.ID
    WHERE rd.DELETED_FLG = FALSE AND p.DELETED_FLG = FALSE AND rd.RECEIPTSDETAILSDATE >= ${innerDateCond} AND p.ID IN (4,6,7,10)
),
ops_dwc_raw AS (
    SELECT * FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC
    WHERE SOURCE = 'DWC' AND OPERATION_DT >= DATEADD('day', -30, ${innerDateCond}::timestamp_ntz) AND CUSTOMERNAME NOT IN ('QEEE', 'EMEX')
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
        'DWC' AS "Склад", COALESCE(CUSTOMERNAME,'EMEX') AS "Заказчик",
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
        'DWC' AS "Склад", COALESCE(o.CUSTOMERNAME,'EMEX') AS "Заказчик",
        1 AS claim_ct, COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_qty,
        COALESCE(o.DETAILPRICEBUY, 0) * COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_amount,
        COALESCE(o.USERNAME, 'UNKNOWN') AS "USER", o.DETAILNAME AS "Наименование", o.ITEM_TYPE AS "Тип товара"
    FROM ops_dwc_enriched o
    WHERE o.next_op_dt IS NOT NULL AND DATEDIFF('day', o.OPERATION_DT, o.next_op_dt) >= 30
      AND o.TYPE NOT IN ('CARGO_PLACE','PLACE','PACK','REPACK','PACK_NEW_BOX','STOCK_PLACE','CARGO_SHIP','EXPERT','EXPERTISE')
      AND DATEADD('day', 30, o.OPERATION_DT) >= ${innerDateCond}::timestamp_ntz
),
dwc_all_defects AS (
    SELECT * FROM dwc_receipt_defects_prepared UNION ALL SELECT * FROM dwc_time_defect_events
),
dwc_union AS (
    SELECT "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение",
        "Склад","Заказчик", SUM(claim_ct) AS "Количество отклонений",
        SUM(claim_qty) AS "Кол-во шт в отклонении", SUM(claim_amount) AS "Сумма в руб. отклонений",
        "USER","Наименование","Тип товара"
    FROM dwc_all_defects GROUP BY "ДатаВремя","День","Неделя","Час","Смена","Этап","Категория отклонения","Отклонение","Склад","Заказчик","USER","Наименование","Тип товара"
),
all_defects_final AS (
    SELECT * FROM BD_UNION
    UNION ALL SELECT * FROM kdz_union
    UNION ALL SELECT * FROM dwc_union
)
`;
}

/**
 * Column name mapping: Snowflake returns Russian column names, 
 * we map them to the English names used by the frontend.
 */
export const SF_COL_MAP: Record<string, string> = {
  "ДатаВремя": "datetime",
  "День": "day",
  "Неделя": "week",
  "Час": "hour",
  "Смена": "shift",
  "Этап": "stage",
  "Категория отклонения": "deviation_category",
  "Отклонение": "deviation",
  "Склад": "warehouse",
  "Заказчик": "customer",
  "Количество отклонений": "deviation_count",
  "Кол-во шт в отклонении": "quantity",
  "Сумма в руб. отклонений": "amount_rub",
  "USER": "employee",
  "Наименование": "product_name",
  "Тип товара": "item_type",
};

export function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const newKey = SF_COL_MAP[key] || key;
    mapped[newKey] = value;
  }
  // Normalize date columns to strings
  if (mapped.datetime instanceof Date) mapped.datetime = mapped.datetime.toISOString().replace("T", " ").split(".")[0];
  if (mapped.day instanceof Date) mapped.day = mapped.day.toISOString().split("T")[0];
  if (mapped.week instanceof Date) mapped.week = mapped.week.toISOString().split("T")[0];
  return mapped;
}
