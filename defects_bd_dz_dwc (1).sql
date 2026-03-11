------BD
with u AS (
    --берем инфу о сотрудниках
    SELECT
        name,
        exceed::varchar as login,
        zup
    FROM
        DWH.ODS_MSK_RSC.V_USER
    where
        zup is not null
    group by
        name,
        exceed,
        zup
    union all
    SELECT
        name,
        id::varchar as login,
        zup
    FROM
        DWH.ODS_MSK_RSC.V_USER
    where
        zup is not null
    group by
        name,
        id,
        zup
),
p as (
    --пользователь, который запаковал ГМ и дата операции
    select
        u.name,
        u.zup,
        o.sku,
        o.event_dttm
    from
        DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
        left join u on o.user = u.login
    where
        o.EVENT_TYPE = 'CARGO_PACK'
        and o.event_dttm >= '2025-10-01' QUALIFY rank() over (
            partition by o.sku
            order by
                o.event_id desc
        ) = 1
),
cs as (
    --пользователь, который запаковал ГМ и дата операции
    select
        u.name,
        u.zup,
        o.sku,
        o.event_dttm
    from
        DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
        left join u on o.user = u.login
    where
        o.EVENT_TYPE = 'CARGO_SHIP'
        and o.event_dttm >= '2025-10-01' QUALIFY rank() over (
            partition by o.sku
            order by
                o.event_id desc
        ) = 1
),
gm as (
    --определяем цену последнего поступления товара
    select
        detail_article,
        max(EVENT_DTTM) as dt
    from
        DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_EXPECTED_GOODS_ARRIVAL_TOMILINO_GOODS
    group by
        detail_article
),
n as (
    --справочник уникальных арткулов и sku
    select
        detail_article,
        code::varchar as code,
        uuid,
        GOODS_TYPE
    from
        DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_NOMENCLATURE
    group by
        detail_article,
        code,
        uuid,
        GOODS_TYPE
),
sku as (
    --определяем тип товара у каждого sku
    select
        sk.sku,
        sk.storerkey,
        case
            when sk.putawayzone like 'MZ%' then 'SMALL'
            when DIV0(
                pz.v,
                (
                    CASE
                        WHEN POSITION('-' IN sk.packkey) = 0 THEN 0 --это STD
                        --для формата PACK-1000(500X2PT)
                        WHEN POSITION('(' IN sk.packkey) > 0 THEN SUBSTRING(
                            sk.packkey,
                            POSITION('-' IN sk.packkey) + 1,
                            POSITION('(' IN sk.packkey) - POSITION('-' IN sk.packkey) -1
                        ) --для формата PACK-600-12-50
                        WHEN (
                            CHARINDEX('-', sk.packkey) > 0
                            AND CHARINDEX('-', sk.packkey, CHARINDEX('-', sk.packkey) + 1) > 0
                        ) THEN SUBSTRING(
                            sk.packkey,
                            CHARINDEX('-', sk.packkey) + 1,
                            CHARINDEX('-', sk.packkey, CHARINDEX('-', sk.packkey) + 1) - CHARINDEX('-', sk.packkey) -1
                        )
                        ELSE SUBSTRING(sk.packkey, POSITION('-' IN sk.packkey) + 1)
                    END
                )
            ) < 0.1 then 'NORMAL'
            else COALESCE(sk.busr10, 'BIG')
        end as type
    from
        DWH.ODS_MSK_PDC_ORACLE.V_SKU_ODS_UNION sk
        left join DWH.ODS_MSK_PDC_ORACLE.V_PUTAWAYZONE_ODS_UNION pz on sk.whseid = pz.whseid
        and sk.putawayzone = pz.putawayzone
    where
        pz.sklad in ('KBD', 'BD1', 'KDZ', 'KTH', 'K51', 'KKN')
        and sk.storerkey in ('MAS', 'AKS', 'DM', 'PCR', 'FOT', 'GAK', 'MME')
    group by
        sku,
        storerkey,
        type,
        sk.putawayzone,
        pz.v,
        sk.packkey,
        sk.busr10
),
prices as (
    --определяем цену по последней цене прихода товара на склад
    select
        max(g.UNIT_PRICE) as price,
        n.code as sku
    from
        DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_EXPECTED_GOODS_ARRIVAL_TOMILINO_GOODS as g
        inner join gm on g.detail_article = gm.detail_article
        and g.event_dttm = gm.dt
        left join n on gm.detail_article = n.detail_article
    group by
        sku
    having
        max(g.UNIT_PRICE) >= 0
),
reklamacii AS (
    select
        case
            when ec.problem_code = 'Недостача ГМ' then cs.event_dttm --если по отклонение гм, то дата операции отгрузки
            when ec.problem_code in (
                'Излишки',
                'Пересорт',
                'Недостача',
                'Заводской брак',
                'Механические повреждения',
                'Некомплект'
            ) then p.event_dttm --если по отклонение гм, то дата операции отгрузки
            else date_trunc(
                hour,
                TO_DATE(
                    REGEXP_SUBSTR(link, '\\d{2}\\.\\d{2}\\.\\d{4}'),
                    --в остальных случаях дата поступления рекламации
                    'DD.MM.YYYY'
                )
            )
        end as "ДатаВремя",
        "ДатаВремя"::date as "День",
        date_trunc(week, "ДатаВремя")::date as "Неделя",
        extract(
            hour
            from
                "ДатаВремя"
        ) as "Час",
        case
            when "Час" >= 8
            and "Час" <= 20 then 1
            else 2
        end as "Смена",
        case
            when ec.problem_code in (
                'Излишки',
                'Пересорт',
                'Недостача',
                'Заводской брак',
                'Механические повреждения',
                'Некомплект'
            ) then 'Упаковка'
            when ec.problem_code in ('Недостача ГМ') then 'Отгрузка ГМ'
            else 'Неизвестно'
        end as "Этап",
        case
            when ec.problem_code in (
                'Излишки',
                'Недостача ГМ',
                'Пересорт',
                'Недостача'
            ) then 'По количеству'
            when ec.problem_code in (
                'Заводской брак',
                'Механические повреждения',
                'Некомплект'
            ) then 'По качеству'
            else ec.problem_code
        end as "Категория отклонения",
        case
            when ec.problem_code = 'Излишки' then 'излишек'
            when ec.problem_code in ('Недостача ГМ', 'Недостача') then 'недостача'
            when ec.problem_code in (
                'Заводской брак',
                'Механические повреждения',
                'Некомплект'
            ) then 'повреждение'
            else ec.problem_code
        end as "Отклонение",
        case
            when ss.STORERKEY = 'AKS' then 'BD1' --'AKS'
            when ss.STORERKEY = 'MAS' then 'BD1' --'MAS'
            when ss.STORERKEY = 'GAK' then 'BD1' --'GAK'
            when ss.STORERKEY = 'DM' then 'KBD' --'DM'
            when ss.STORERKEY = 'MMR' then 'K41' --'MMR'
            when ss.STORERKEY = 'HAV' then 'K40' --'HAV'
            when ss.STORERKEY = 'HIN' then 'KDZ' --'HIN'
            when ss.STORERKEY = 'FOT' then 'KBD' --'FOT'
            when ss.STORERKEY = 'MME' then 'BD1' --'MME'
            when ss.STORERKEY = 'PCR' then 'BD1' --'MME'
            else 'KDZ'
        end as "Склад",
        ss.storerkey as "Заказчик",
        count(EVENT_ID) as "Количество отклонений",
        --кол-во рекламаций
        sum(abs(from_claim_cnt)) as "Кол-во шт в отклонении",
        --кол-во штук товара по рекламации
        sum(PDK_CLAIM_PRICE_WITHOUT_NDS_AMT) as "Сумма в руб. отклонений",
        -- сумма рекламаций
        concat(
            case
                when "Этап" = 'Упаковка' then p.zup
                when "Этап" = 'Отгрузка ГМ' then cs.zup
            end,
            ' ',case
                when "Этап" = 'Упаковка' then p.name
                when "Этап" = 'Отгрузка ГМ' then cs.name
            end
        ) as user,
        ec.detail_num as "Наименование",
        s.TYPE as "Тип товара"
    from
        dwh.emart.msk_expedition_claim as ec
        left join DWH.MD.STORAGE_STORERKEY_ACTIVE as SS on ec.client = ss.owner
        left join p on ec.box_id = p.sku
        and ec.problem_code != 'Недостача ГМ'
        left join cs on ec.box_id = cs.sku
        and ec.problem_code = 'Недостача ГМ'
        left join n on ec.detail_num_id = n.uuid
        left join sku s on n.code = s.sku
        and ss.storerkey = s.storerkey
    where
        1 = 1 --and claim_status = 'Отработано'
        --and set_pdk = 'Да'
        and ec.problem_code not in ('Опоздание', 'Инвентаризация')
        AND NOT error_stage1 IN (
            'Доставка ПДК',
            'Перевозчик',
            'Перевозчик от ЭР до Оптовика'
        )
        and "ДатаВремя" >= '2026-01-01' --and "ДатаВремя" < '2026-02-11'
    group by
        "ДатаВремя",
        "Этап",
        "Категория отклонения",
        "Отклонение",
        "Склад",
        "Заказчик",
        user,
        ec.detail_num,
        s.TYPE
),
ops as (
    select
        *,
        lag(user) over (
            partition by sku
            order by
                event_dttm
        ) as prev_user,
        lag(event_dttm) over (
            partition by sku
            order by
                event_dttm
        ) as prev_action,
        case
            when prev_action is not null then datediff(minute,prev_action,event_dttm)
            else datediff(minute,event_dttm,current_timestamp())
        end as action_time,
        case
            when action_time > 43200 then 1
            else 0
        end as defect30flag        
    from
        DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS
),
defects30days as (
    select
        dateadd(minute, 43200, ops.event_dttm) as "ДатаВремя",
        date_trunc(day, "ДатаВремя") as "День",
        date_trunc(week, "ДатаВремя") as "Неделя",
        extract(
            hour
            from
                "ДатаВремя"
        ) as "Час",
        case
            when "Час" >= 8
            and "Час" <= 20 then 1
            else 2
        end as "Смена",
        case
            when ops.EVENT_TYPE = 'CARGO_PLACE' then 'Размещение ГМ'
            when ops.EVENT_TYPE = 'CARGO_PACK' then 'Упаковка ГМ'
            when ops.EVENT_TYPE IN ('CARGO_SHIP','AKS_CARGO_SHIP') then 'Отгрузка ГМ'
        end as "Этап",
        'По количеству' as "Категория отклонения",
        'Не было движений 30+ дней' as "Отклонение",
        case when ops.warehouse_code IN ('K41','К41') then 'BD1'
             when ops.warehouse_code IN ('K40','К40') then 'KBD'
             else ops.warehouse_code
        end as "Склад",
        ops.storer as "Заказчик",
        1 as "Количество отклонений",
        ops.sku_cnt as "Кол-во шт в отклонении",
        ops.sku_cnt * pr.price as "Сумма в руб. отклонений",
        COALESCE(
            concat(
                u.zup,
                ' ',
                u.name
            ),
            ops.prev_user
        ) as user,
        ops.sku_nm as "Наименование",
        'BOX' as "Тип товара"
    from
        ops
        left join prices as pr on ops.sku = pr.sku
        left join u on ops.prev_user = u.login
    where
        ops.defect30flag = 1
        and "ДатаВремя" >= '2026-01-01'
        and ops.EVENT_TYPE ilike '%cargo%'
        and ops.sku_nm != 'NONE'
),
ops_dz as (
    select
        *,
        lag(USER_ID) over (
            partition by OBJECTCODE
            order by
                OPERATION_DT
        ) as prev_user
    from
        DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC
    where
        SOURCE = 'KDZ'
        and OPERATION_DT >= '2025-11-01'
    qualify row_number() over (partition by type, OBJECTKEY order by OPERATION_DT desc) = 1
),
lost as (
    select
        event_dttm as "ДатаВремя",
        event_dttm::date as "День",
        date_trunc(week, event_dttm) as "Неделя",
        extract(
            hour
            from
                "ДатаВремя"
        ) as "Час",
        case
            when "Час" >= 8
            and "Час" <= 20 then 1
            else 2
        end as "Смена",
        'Хранение' as "Этап",
        case
            when cell_to ilike '%lost%'
            or cell_to ilike '%karant%' then 'По количеству'
            else 'По качеству'
        end as "Категория отклонения",
        case
            when cell_to ilike '%lost%' then 'недостача'
            when cell_to ilike '%karant%' then 'излишек'
            else 'повреждение'
        end as "Отклонение",
        warehouse_code as "Склад",
        storer as "Заказчик",
        1 as "Количество отклонений",
        sku_cnt as "Кол-во шт в отклонении",
        o.sku_cnt * pr.price as "Сумма в руб. отклонений",
        COALESCE(
            concat(
                u.zup,
                ' ',
                u.name
            ),
            o.prev_user
        ) as user,
        o.sku_nm as "Наименование",
        case
            when o.warehouse_zone like 'MZ%' then 'SMALL'
            when DIV0(
                o.warehouse_zone_volume,
                (
                    CASE
                        WHEN POSITION('-' IN o.sku_pack_code) = 0 THEN 0 --это STD
                        --для формата PACK-1000(500X2PT)
                        WHEN POSITION('(' IN o.sku_pack_code) > 0 THEN SUBSTRING(
                            o.sku_pack_code,
                            POSITION('-' IN o.sku_pack_code) + 1,
                            POSITION('(' IN o.sku_pack_code) - POSITION('-' IN o.sku_pack_code) -1
                        ) --для формата PACK-600-12-50
                        WHEN (
                            CHARINDEX('-', o.sku_pack_code) > 0
                            AND CHARINDEX(
                                '-',
                                o.sku_pack_code,
                                CHARINDEX('-', o.sku_pack_code) + 1
                            ) > 0
                        ) THEN SUBSTRING(
                            o.sku_pack_code,
                            CHARINDEX('-', o.sku_pack_code) + 1,
                            CHARINDEX(
                                '-',
                                o.sku_pack_code,
                                CHARINDEX('-', o.sku_pack_code) + 1
                            ) - CHARINDEX('-', o.sku_pack_code) -1
                        )
                        ELSE SUBSTRING(
                            o.sku_pack_code,
                            POSITION('-' IN o.sku_pack_code) + 1
                        )
                    END
                )
            ) < 0.1 then 'NORMAL'
            else COALESCE(o.sku_busr, 'BIG')
        end as "Тип товара"
    from
        ops o
        left join prices as pr on o.sku = pr.sku
        left join u on o.prev_user = u.login
    where
        1 = 1 --and event_dttm >= '2026-01-01'
        and (
            cell_to ilike '%lost%' --or cell_to ilike '%dolg%'
            or cell_to ilike '%bra%'
            or cell_to ilike '%rack%'
            or cell_to ilike '%karant%'
        ) --and cell_to not in ('DOLGI BRAK', 'DOLGI LOST', 'DOLGIUT')
        and sku_cnt > 0
),
departure_dttm AS(
    -- убытие по расписанию
    SELECT
        LINK,
        voyage_dt,
        SUM(VOLUME) AS LOADED_VOLUME,
        MAX(PLANNED_TOM_DEPARTURE_DTTM) AS PLANNED_TOM_DEPARTURE_DTTM,
        MAX(PLANNED_BD_DEPARTURE_DTTM) AS PLANNED_BD_DEPARTURE_DTTM,
        MAX(PLANNED_DZE_DEPARTURE_DTTM) AS PLANNED_DZE_DEPARTURE_DTTM
    FROM
        (
            SELECT
                DISTINCT LINK,
                --LEFT(LINK, POSITION('от' IN LINK) - 2)  AS SHORT_LINK,
                TO_DATE(
                    REGEXP_SUBSTR(Link, '\\d{2}\\.\\d{2}\\.\\d{4}'),
                    -- извлекаем дату в формате dd.mm.yyyy
                    'DD.MM.YYYY'
                ) AS voyage_dt,
                VOLUME,
                MAX(
                    CASE
                        WHEN WAREHOUSE = 'Томилино' THEN DATEADD(HOUR, 3, PLANNED_DEPARTURE_DTTM)
                        ELSE NULL
                    END
                ) AS PLANNED_TOM_DEPARTURE_DTTM,
                MAX(
                    CASE
                        WHEN WAREHOUSE in ('Кожухово', 'Белая Дача') THEN DATEADD(HOUR, 3, PLANNED_DEPARTURE_DTTM)
                        ELSE NULL
                    END
                ) AS PLANNED_BD_DEPARTURE_DTTM,
                MAX(
                    CASE
                        WHEN WAREHOUSE = 'Дзержинский' THEN DATEADD(HOUR, 3, PLANNED_DEPARTURE_DTTM)
                        ELSE NULL
                    END
                ) AS PLANNED_DZE_DEPARTURE_DTTM
            FROM
                DWH.ODS_1C_PDCIS.PDCIS_EXPEDITION_VOYAGE_LOAD_WAREHOUSE
            WHERE
                WAREHOUSE IN (
                    'Томилино',
                    'Кожухово',
                    'Белая Дача',
                    'Дзержинский'
                ) --AND LINK iLIKE '%392840%'
            GROUP BY
                1,
                2,
                3
        )
    GROUP BY
        1,
        2
),
data AS (
    -- экспедиционный датасет
    SELECT
        DISTINCT d.CONSIGNEE,
        d.CLIENT,
        d.DELIVERY_CITY,
        d.DROPID,
        d.LAST_WAREHOUSE,
        d.VOYAGE_NUM,
        d.VOYAGE_LINK,
        d.ROUTE_PDC,
        d.NEW_LOADED_VOLUME,
        d.NEW_CAR_VOLUME,
        dd.PLANNED_TOM_DEPARTURE_DTTM,
        dd.PLANNED_BD_DEPARTURE_DTTM,
        dd.PLANNED_DZE_DEPARTURE_DTTM,
        d.DELIVERY_ORDER_DTTM,
        d.PARCELMOVED_EV_DTTM,CASE
            WHEN d.LAST_WAREHOUSE IN ('БД', 'БД1') THEN dd.PLANNED_BD_DEPARTURE_DTTM
            WHEN d.LAST_WAREHOUSE IN ('К41', 'К40', 'KTH', 'KKN') THEN dd.PLANNED_TOM_DEPARTURE_DTTM
            WHEN d.LAST_WAREHOUSE = 'ДЗ' THEN dd.PLANNED_DZE_DEPARTURE_DTTM
            ELSE NULL
        END AS PLANNED_DEPARTURE_DTTM
    FROM
        DWH.EMART.HWC_BOXES_LIFECYCLE AS d
        LEFT JOIN departure_dttm AS dd ON d.VOYAGE_LINK = dd.LINK
    WHERE
        DATE(d.PARCELMOVED_EV_DTTM) >= '2026-01-01' --AND '2025-12-09'
        -- убираем, так как у них нестандартное расписание / нестандартные рейсы
        AND d.ROUTE_PDC NOT iLIKE '%самов%'
        AND d.ROUTE_PDC NOT iLIKE '%авиа%'
        AND d.ROUTE_PDC NOT iLIKE '%разовая%'
        AND d.ROUTE_PDC NOT iLIKE '%пустенько%'
        AND d.ROUTE_PDC NOT iLIKE '%шатл%'
        AND d.ROUTE_PDC NOT iLIKE '%шаттл%'
        AND d.ROUTE_PDC NOT iLIKE '%переброс%'
        AND d.ROUTE_PDC NOT iLIKE '%переезд%'
        AND d.CARRIER NOT iLIKE '%самов%' --AND PLANNED_DEPARTURE_DTTM IS NOT NULL --убираем ГМ, которые запланированы в рейс, но машина на склад не заезжала за ними
),
ROUTES AS (
    -- создаем словарь грузополучатель -> его маршруты
    SELECT
        *
    FROM
        (
            SELECT
                CONSIGNEE,
                DELIVERY_CITY,
                LAST_WAREHOUSE,
                ROUTE_PDC,
                COUNT(DISTINCT(DROPID)) AS DROPIDS
            FROM
                data
            GROUP BY
                CONSIGNEE,
                DELIVERY_CITY,
                LAST_WAREHOUSE,
                ROUTE_PDC
        )
    WHERE
        DROPIDS > 5 -- фильтр на кривые заведения
        AND ROUTE_PDC IS NOT NULL
        AND LAST_WAREHOUSE IS NOT NULL
),
able_routes AS (
    -- все маршруты, которые были за выбранный период с проверкой их утилизации
    SELECT
        DISTINCT LAST_WAREHOUSE,
        VOYAGE_NUM,
        ROUTE_PDC,
        PLANNED_TOM_DEPARTURE_DTTM,
        PLANNED_BD_DEPARTURE_DTTM,
        PLANNED_DZE_DEPARTURE_DTTM,
        CASE
            WHEN LAST_WAREHOUSE IN ('БД', 'БД1') THEN PLANNED_BD_DEPARTURE_DTTM
            WHEN LAST_WAREHOUSE IN ('К41', 'К40', 'KTH', 'KKN') THEN PLANNED_TOM_DEPARTURE_DTTM
            WHEN LAST_WAREHOUSE = 'ДЗ' THEN PLANNED_DZE_DEPARTURE_DTTM
            ELSE NULL
        END AS POTENTIAL_PLANNED_DEPARTURE_DTTM,
        NEW_LOADED_VOLUME / NEW_CAR_VOLUME * 100 AS UTIL
    FROM
        data
),
final_res as (
    SELECT
        PARCELMOVED_EV_DTTM as dt,
        DATE_TRUNC('day', PARCELMOVED_EV_DTTM) AS Day,
        DATE_TRUNC('week', PARCELMOVED_EV_DTTM) AS W,
        --VOYAGE_NUM,
        --PLANNED_DEPARTURE_DTTM as voyage_dt,
        --d_ROUTE_PDC,
        CASE
            when LAST_WAREHOUSE = 'БД' then 'KBD'
            when LAST_WAREHOUSE = 'БД1' then 'BD1'
            when CLIENT = 'АвтоБиз' then 'BD1'
            when LAST_WAREHOUSE = 'ДЗ' then 'KDZ'
        END AS WH,
        CLIENT AS STORER,
        DROPID,
        --DISTINCT(
        CASE
            WHEN rn = 1
            AND (
                POTENTIAL_PLANNED_DEPARTURE_DTTM = PLANNED_DEPARTURE_DTTM
            ) THEN DROPID
            WHEN PREV_UTIL > 70
            AND rn = 2
            AND (
                POTENTIAL_PLANNED_DEPARTURE_DTTM = PLANNED_DEPARTURE_DTTM
            ) THEN DROPID
            ELSE NULL
        END --)
        AS "ГМ_ОТГРУЖЕНО_В_БЛИЖАЙШЕМ_РЕЙСЕ",
        POTENTIAL_VOYAGE_NUM --,POTENTIAL_PLANNED_DEPARTURE_DTTM as pot_voyage_dt
        --"ГМ_ОТГРУЖЕНО_В_БЛИЖАЙШЕМ_РЕЙСЕ" / "ВСЕГО_ГМ" AS "%_ОТГРУЖЕНЫХ_В_БЛИЖАЙШЕМ_РЕЙСЕ_ГМ"
    FROM
        (
            SELECT
                *,
                LAG(UTIL) OVER(
                    partition by DROPID
                    order by
                        POTENTIAL_PLANNED_DEPARTURE_DTTM
                ) AS PREV_UTIL -- поправка на перегруженность первого ближайшего рейса --04042025 o.vazhenin: тут добавил partition by DROPID
,
                row_number() over (
                    partition by DROPID
                    order by
                        POTENTIAL_PLANNED_DEPARTURE_DTTM ASC
                ) as rn -- расчитываем длижайший подходящий рейс по времени  --04042025 o.vazhenin: тут сортируем по POTENTIAL_PLANNED_DEPARTURE_DTTM
            FROM
                (
                    SELECT
                        DISTINCT d.CONSIGNEE,
                        d.CLIENT,
                        d.DELIVERY_CITY,
                        d.DROPID,
                        d.DELIVERY_ORDER_DTTM,
                        d.PARCELMOVED_EV_DTTM,
                        d.LAST_WAREHOUSE,
                        d.VOYAGE_NUM,
                        d.ROUTE_PDC AS d_ROUTE_PDC,
                        d.PLANNED_TOM_DEPARTURE_DTTM,
                        d.PLANNED_BD_DEPARTURE_DTTM,
                        d.PLANNED_DZE_DEPARTURE_DTTM,
                        d.PLANNED_DEPARTURE_DTTM,
                        r.ROUTE_PDC AS r_ROUTE_PDC,
                        r.DROPIDS,
                        p.ROUTE_PDC AS POTENTIAL_ROUTE_PDC,
                        p.VOYAGE_NUM AS POTENTIAL_VOYAGE_NUM,
                        p.PLANNED_TOM_DEPARTURE_DTTM AS POTENTIAL_PLANNED_TOM_DEPARTURE_DTTM,
                        p.PLANNED_BD_DEPARTURE_DTTM AS POTENTIAL_PLANNED_BD_DEPARTURE_DTTM,
                        p.PLANNED_DZE_DEPARTURE_DTTM AS POTENTIAL_PLANNED_DZE_DEPARTURE_DTTM,
                        p.POTENTIAL_PLANNED_DEPARTURE_DTTM,
                        p.UTIL,
                        DATEDIFF(
                            millisecond,
                            d.PARCELMOVED_EV_DTTM,
                            p.POTENTIAL_PLANNED_DEPARTURE_DTTM
                        ) TIME_DIFF --04042025 o.vazhenin: тут считаем разницу в millisecond потому что реальные есть рейсы у которых такая разница (возможно это баг)
                    FROM
                        data AS d
                        LEFT JOIN ROUTES AS r ON d.CONSIGNEE = r.CONSIGNEE
                        AND d.LAST_WAREHOUSE = r.LAST_WAREHOUSE
                        AND d.DELIVERY_CITY = r.DELIVERY_CITY
                        LEFT JOIN -- джойним к ГМ все маршруты, которые ему соответствуют, в том числе и те, которые уехали ДО его появления в зоне карго. Далее их будем убирать, сравнивая разницу дат
                        able_routes AS p ON d.LAST_WAREHOUSE = p.LAST_WAREHOUSE
                        AND r.ROUTE_PDC = p.ROUTE_PDC
                        and p.POTENTIAL_PLANNED_DEPARTURE_DTTM > d.PARCELMOVED_EV_DTTM
                        and p.POTENTIAL_PLANNED_DEPARTURE_DTTM <= d.PLANNED_DEPARTURE_DTTM
                    WHERE
                        1 = 1
                        AND (
                            TIME_DIFF >= 0
                            OR TIME_DIFF IS NULL
                        ) -- не считаем ГМ, которые готовы к отгрузке прям совсем близко к рейсу, так как могут не успеть подготовить документы
                        --04042025 o.vazhenin:тут такое условие чтобы 1) не потерять рейсы которые фактически уехали через несколько секунд после PARCELMOVED_EV_DTTM; 2) в "ВСЕГО_ГМ" не потерять рейсы для которых не нашлись потециальные рейсы
                        AND NOT d.VOYAGE_NUM IS NULL
                )
        )
    WHERE
        1 = 1
    group by all
),
price_subid as (
 select ORDERDETAILSUBID,
        max(detailpricebuyrur) as detailpricebuyrur
 from DWH.ODS_MSK_EMEXMAIN_DBO.INVOICESDETAILS
    group by ORDERDETAILSUBID
),
gm_not_first_voyage as (
    select
        f.dt as "ДатаВремя",
        f.Day as "День",
        f.W as "Неделя",
        extract(
            hour
            from
                "ДатаВремя"
        ) as "Час",
        case
            when "Час" >= 8
            and "Час" <= 20 then 1
            else 2
        end as "Смена",
        'Отгрузка ГМ' as "Этап",
        'По времени' as "Категория отклонения",
        'Опоздание' as "Отклонение",
        f.wh as "Склад",
        ska.storerkey as "Заказчик",
        1 as "Количество отклонений",
        case
            when f.wh != 'KDZ' then sum(pd.qty)
            else sum(rd.DETAILQUANTITY)
        end as "Кол-во шт в отклонении",
        --case
            --when f.wh != 'KDZ' then sum(pd.qty * pr.price)
            --else sum(rd.DETAILQUANTITY * id.detailpricebuyrur)
        --end
        0 as "Сумма в руб. отклонений",
        case
            when f.wh != 'KDZ' then COALESCE(
                concat(
                    u.zup,
                    ' ',
                    u.name
                ),
                o.prev_user
            )
            else COALESCE(
                concat(
                    udz.TABNUMBER,
                    ' ',
                    udz.USERNAME
                ),
                dz.prev_user
            )
        end as user,
        f.dropid as "Наименование",
        'BOX' as "Тип товара"
    from
        final_res f
        left join DWH.MD.STORAGE_STORERKEY_ACTIVE ska on f.STORER = ska.owner
        left join DWH.ODS_MSK_PDC_ORACLE.V_DROPIDDETAIL_ODS_UNION dd on f.DROPID = dd.DROPID
        LEFT JOIN DWH.ODS_MSK_PDC_ORACLE.V_PICKDETAIL_ODS_UNION pd ON pd.CASEID = dd.CHILDID
        LEFT JOIN DWH.ODS_MSK_PDC_ORACLE.V_SKU_ODS_UNION sk ON pd.SKU = sk.sku
        AND pd.WHSEID = sk.WHSEID
        AND pd.STORERKEY = sk.STORERKEY
        left join prices as pr on sk.sku = pr.sku
        left join ops o on f.dropid = o.sku
        and o.EVENT_TYPE = 'CARGO_SHIP'
        left join ops_dz dz on f.dropid = dz.OBJECTCODE
        and dz.TYPE = 'CARGO_SHIP'
        --left join ops_dz dzp on f.dropid = dzp.TOCONTAINERCODE
        --and dzp.TYPE = 'PLACE' and dzp.TOCONTAINERCODE != ''
        left join u on o.prev_user = u.login
        left join DWH.ODS_MSK_EMEXMAIN_DBO.USERS udz on dz.prev_user = udz.userid
        left join DWH.ODS_MSK_EMEXMAIN_DBO.BOXESREGIONS br on f.dropid = br.barcode
        left join DWH.ODS_MSK_EMEXMAIN_DBO.RECEIPTSDETAILS rd on br.boxregid = rd.boxregid
        left join price_subid id on rd.orderdetailsubid = id.ORDERDETAILSUBID
    where
        1 = 1
        and "ГМ_ОТГРУЖЕНО_В_БЛИЖАЙШЕМ_РЕЙСЕ" is null
        and POTENTIAL_VOYAGE_NUM is not null
    group by
        f.dt,
        f.Day,
        f.W,
        f.wh,
        ska.storerkey,
        u.zup,
        u.name,
        o.prev_user,
        f.dropid,
        udz.TABNUMBER,
        udz.USERNAME,
        dz.prev_user
        --,user
),
defects_bd as (
    select
        distinct *
    from
        lost
    union all
    select
        distinct *
    from
        reklamacii
    union all
    select
        distinct *
    from
        gm_not_first_voyage
    union all
    select
        distinct *
    from
        defects30days
),
BD_UNION as (
select
    *
from
    defects_bd where "ДатаВремя" >= '2026-01-01' ),
    --------------------------------------------------------------------KDZ
 kdz_ops_all AS (
    SELECT
        o.*,

        LAG(o.USERNAME) OVER (
            PARTITION BY o.OBJECTKEY
            ORDER BY o.OPERATION_DT
        ) AS prev_username,

        LAG(o.TYPE) OVER (
            PARTITION BY o.OBJECTKEY
            ORDER BY o.OPERATION_DT
        ) AS prev_type,

        LAST_VALUE(o.DETAILPRICEBUY) IGNORE NULLS OVER (
            PARTITION BY o.OBJECTKEY
            ORDER BY o.OPERATION_DT
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS price_eff,

        -- чтобы везде одинаково считать qty
        COALESCE(NULLIF(o.ITEMS, 0), 1) AS qty_eff,

        -- текущий этап (для time-дефекта берём этап последнего движения перед простоем)
        CASE
            WHEN o.TYPE IN ('RECEIPTING','STOCK_RECEIPTING')              THEN 'Приемка'
            WHEN o.TYPE IN ('PICK','STOCK_PICK','STOCK_PICKING')         THEN 'Подбор'
            WHEN o.TYPE = 'PLACE'                                        THEN 'Размещение'
            WHEN o.TYPE IN ('SORT','PRESORTING')                         THEN 'Сортировка'
            WHEN o.TYPE IN ('PACK','REPACK')                             THEN 'Упаковка'
            WHEN o.TYPE IN ('EXPERT','EXPERTISE')                        THEN 'Экспертиза'
            WHEN o.TYPE = 'INVENTORY'                                    THEN 'Хранение'
            WHEN o.TYPE = 'BOX_PLACE'                                    THEN 'Размещение коробов'
            WHEN o.TYPE = 'UNKNOWN'                                      THEN 'Неизвестно'
            WHEN o.TYPE IN ('CARGO_PLACE','CARGO_PICK', 'CARGO_SHIP') THEN 'Отгрузка'
            ELSE COALESCE(o.TYPE, 'Неизвестно')
        END AS stage_curr

    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC o
    -- лучше так, чтобы поймать "дефект в 2026", даже если последнее движение было в конце 2025
    WHERE o.OPERATION_DT >= DATEADD('day', -30, '2026-01-01'::timestamp)
      AND o.SOURCE = 'KDZ' 
),

/* разрывы между соседними движениями */
kdz_ops_gaps AS (
    SELECT
        o.*,
        case when LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT) is null then current_date()
        else LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT)
        end AS next_op_dt,
       ---- LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTKEY ORDER BY o.OPERATION_DT) AS next_op_dt
    FROM kdz_ops_all o
),

/* дефекты LOST/888888 */
kdz_defect_events AS (
    SELECT
        o.OPERATION_DT AS "ДатаВремя",
        DATE_TRUNC('day',  o.OPERATION_DT)::date AS "День",
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
            WHEN o.prev_type = 'UNKNOWN'   THEN 'Неизвестно'
            ELSE COALESCE(o.prev_type, 'Неизвестно')
        END AS "Этап",

        'По количеству' AS "Категория отклонения",
        'недостача'     AS "Отклонение",

        'KDZ' AS "Склад",
        COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",

        o.qty_eff                  AS claim_qty,
        COALESCE(o.price_eff, 0)   AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,

        COALESCE(o.prev_username, o.USERNAME) AS "USER",

        o.DETAILNAME AS "Наименование",
        o.ITEM_TYPE  AS "Тип товара",
        o.OBJECTCODE
    FROM kdz_ops_all o
    WHERE o.TOPLACECODE IN ('888888', 'LOST')
      AND o.OPERATION_DT >= '2026-01-01'::timestamp
      AND o.prev_type is not null
),

/* time-дефекты: был простой 30+ дней между движениями */
kdz_time_defect_events AS (
    SELECT
        DATEADD('day', 30, o.OPERATION_DT) AS "ДатаВремя",
        DATE_TRUNC('day',  DATEADD('day', 30, o.OPERATION_DT))::date AS "День",
        DATEADD(
            'day',
            -(DAYOFWEEKISO(DATEADD('day', 30, o.OPERATION_DT)) - 1),
            DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT))
        )::date AS "Неделя",
        DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) AS "Час",
        CASE WHEN DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",

        o.stage_curr AS "Этап",
        'По количеству' AS "Категория отклонения",
        'Не было движений 30+ дней' AS "Отклонение",

        'KDZ' AS "Склад",
        COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",

        o.qty_eff                    AS claim_qty,
        COALESCE(o.price_eff, 0)     AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,

        o.USERNAME AS "USER",

        o.DETAILNAME AS "Наименование",
        o.ITEM_TYPE  AS "Тип товара",
        o.OBJECTCODE
    FROM kdz_ops_gaps o
    WHERE 1=1
    ---o.next_op_dt IS NOT NULL
      AND DATEDIFF('day', o.OPERATION_DT, o.next_op_dt) >= 30
      -- показываем дефекты, чья "точка" (op_dt+30) попала в период отчёта
      AND DATEADD('day', 30, o.OPERATION_DT) >= '2026-01-01'::timestamp
      ---and o.stage_curr  not in  ('PACK','REPACK', 'CARGO_SHIP', 'PICK','STOCK_PICK','STOCK_PICKING')
           --- WHEN o.prev_type = 'PLACE' THEN 'Размещение'
      AND o.TYPE NOT IN ('BOX_PLACE','PICK','STOCK_PICK','STOCK_PICKING', 'PLACE', 'CARGO_SHIP', 'STOCK_INVENTORY', 'STOCK_PLACE') 
),

all_defects_kdz AS (
    SELECT * FROM kdz_defect_events
    UNION ALL
    SELECT * FROM kdz_time_defect_events
),

kdz_union as (
SELECT
    "ДатаВремя","День","Неделя","Час","Смена",
    "Этап","Категория отклонения","Отклонение",
    "Склад","Заказчик",

    COUNT(DISTINCT OBJECTCODE) AS "Количество отклонений",
    SUM(claim_qty)            AS "Кол-во шт в отклонении",
    SUM(claim_amount)         AS "Сумма в руб. отклонений",

    "USER","Наименование","Тип товара"
FROM all_defects_kdz
GROUP BY
    "ДатаВремя","День","Неделя","Час","Смена",
    "Этап","Категория отклонения","Отклонение",
    "Склад","Заказчик",
    "USER","Наименование","Тип товара" ),
    ---------------------------------------------------------------------------DWC
 receipt_problems AS (
    SELECT
        CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        p.ID AS problem_id,
        l.CREATEDATE::timestamp_ntz AS createdate,
        p.SHORTNAME,
        CASE
            WHEN p.ID IN (4, 6, 7) THEN 'd21'
            WHEN p.ID = 10         THEN 'd22'
        END AS defect_flag
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM_LINK l
        ON rd.RECEIPTSDETAILID = l.RECEIPTSDETAILID
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM p
        ON l.PROBLEMID = p.ID
    WHERE rd.DELETED_FLG = FALSE
      AND p.DELETED_FLG  = FALSE
      AND rd.RECEIPTSDETAILSDATE >= '2026-01-01'
      AND p.ID IN (4,6,7,10)
),

ops_dwc_raw AS (
    SELECT *
    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC
    WHERE SOURCE = 'DWC'
      -- берем с запасом -30 дней, чтобы поймать дефекты, чья "точка" попадает в 2026
      AND OPERATION_DT >= DATEADD('day', -30, '2026-01-01'::timestamp_ntz)
      and CUSTOMERNAME not in ('QEEE', 'EMEX')
),

ops_dwc_enriched AS (
    SELECT
        o.*,

        -- для receipt-дефектов (кто/что было до)
        LAG(o.TYPE) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT)     AS prev_type,
        LAG(o.USERNAME) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_username,
        LAG(o.USER_ID) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_userid,
        LAG(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS prev_op_dt,

        -- для time-дефектов (следующее движение)
        case when LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) is null then current_date()
        else LEAD(o.OPERATION_DT) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT)
        end AS next_op_dt,
        LEAD(o.TYPE) OVER (PARTITION BY o.OBJECTCODE ORDER BY o.OPERATION_DT) AS next_type

    FROM ops_dwc_raw o
),

/* кто "виноват" в receipt problem — берем последнюю операцию за сутки до createdate */
dwc_defect_actor AS (
    SELECT
        rp.objectcode,
        rp.problem_id,
        rp.defect_flag,
        rp.createdate,

        o.prev_op_dt AS defect_op_dt,
        o.prev_type    AS defect_stage_type, --для дефектов обнаруженных на складе берем предыдущий этап, т.к. считаем что накосячили на пред этапе
        o.prev_userid      AS defect_user_id,
        o.prev_username     AS defect_user,

        o.CUSTOMERNAME,
        o.DETAILNAME,
        o.ITEM_TYPE,

        COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_qty,
        COALESCE(o.DETAILPRICEBUY, 0) * COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_amount
    FROM receipt_problems rp
    JOIN ops_dwc_enriched o
      ON o.OBJECTCODE = rp.objectcode
     AND o.OPERATION_DT <  rp.createdate
     AND o.OPERATION_DT >= DATEADD('day', -1, rp.createdate)
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY rp.objectcode, rp.problem_id, rp.createdate
        ORDER BY o.OPERATION_DT DESC
    ) = 1
),

/* receipt-дефекты (как у тебя), без переатрибуции этапов */
dwc_receipt_defects_prepared AS (
    SELECT
        createdate AS "ДатаВремя",
        DATE_TRUNC('day',  createdate) AS "День",
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

        CASE
            WHEN defect_flag = 'd21' THEN 'По качеству'
            WHEN defect_flag = 'd22' THEN 'По количеству'
            ELSE 'Неизвестно'
        END AS "Категория отклонения",

        CASE
            WHEN defect_flag = 'd21' THEN 'повреждение'
            WHEN defect_flag = 'd22' THEN 'недостача'
            ELSE 'Неизвестно'
        END AS "Отклонение",

        'DWC' AS "Склад",
        COALESCE(CUSTOMERNAME,'EMEX') AS "Заказчик",

        1 AS claim_ct,
        claim_qty,
        claim_amount,

        COALESCE(defect_user, 'UNKNOWN') AS "USER",
        DETAILNAME AS "Наименование",
        ITEM_TYPE  AS "Тип товара"
    FROM dwc_defect_actor
    where defect_stage_type is not null
),

/* time-дефекты: разрыв между движениями >=30 дней
   НО исключаем "нормальный" долгий переход Подбор -> Размещение */
dwc_time_defect_events AS (
    SELECT
        DATEADD('day', 30, o.OPERATION_DT) AS "ДатаВремя",
        DATE_TRUNC('day',  DATEADD('day', 30, o.OPERATION_DT)) AS "День",
        DATEADD(
            'day',
            -(DAYOFWEEKISO(DATEADD('day', 30, o.OPERATION_DT)) - 1),
            DATE_TRUNC('day', DATEADD('day', 30, o.OPERATION_DT))
        ) AS "Неделя",
        DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) AS "Час",
        CASE WHEN DATE_PART('hour', DATEADD('day', 30, o.OPERATION_DT)) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",

        CASE
            WHEN o.TYPE IN ('RECEIPTING','STOCK_RECEIPTING') THEN 'Приемка'
            WHEN o.TYPE IN ('PICK','STOCK_PICK','STOCK_PICKING', 'PICK_BOX') THEN 'Подбор'
            WHEN o.TYPE IN ('PLACE', 'STOCK_PLACE') THEN 'Размещение'
            WHEN o.TYPE IN ('SORT','PRESORTING') THEN 'Сортировка'
            WHEN o.TYPE IN ('PACK','REPACK','PACK_NEW_BOX') THEN 'Упаковка'
            WHEN o.TYPE IN ('EXPERT','EXPERTISE') THEN 'Экспертиза'
            WHEN o.TYPE IN ('CARGO_PLACE','CARGO_PICK', 'CARGO_SHIP') THEN 'Отгрузка'
            else o.TYPE
        END AS "Этап",

        'По количеству' AS "Категория отклонения",
        'Не было движений 30+ дней' AS "Отклонение",

        'DWC' AS "Склад",
        COALESCE(o.CUSTOMERNAME,'EMEX') AS "Заказчик",

        1 AS claim_ct,
        COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_qty,
        COALESCE(o.DETAILPRICEBUY, 0) * COALESCE(NULLIF(o.ITEMS, 0), 1) AS claim_amount,

        COALESCE(o.USERNAME, 'UNKNOWN') AS "USER",
        o.DETAILNAME AS "Наименование",
        o.ITEM_TYPE  AS "Тип товара"
    FROM ops_dwc_enriched o
    WHERE o.next_op_dt IS NOT NULL
      AND DATEDIFF('day', o.OPERATION_DT, o.next_op_dt) >= 30
      -- НЕ считаем долгий "Подбор
      --AND o.TYPE NOT IN ('PICK','STOCK_PICK','STOCK_PICKING', 'PICK_BOX', 'CARGO_PLACE','CARGO_PICK')
      AND o.TYPE NOT IN ('CARGO_PLACE', 'PLACE', 'PACK','REPACK','PACK_NEW_BOX', 'STOCK_PLACE', 'CARGO_SHIP','EXPERT','EXPERTISE')
      -- чтобы "точка дефекта" попадала в период отчета
      AND DATEADD('day', 30, o.OPERATION_DT) >= '2026-01-01'::timestamp_ntz
),

dwc_all_defects AS (
    SELECT * FROM dwc_receipt_defects_prepared
    UNION ALL
    SELECT * FROM dwc_time_defect_events
),

    dwc_union as (
SELECT
    "ДатаВремя","День","Неделя","Час","Смена",
    "Этап","Категория отклонения","Отклонение",
    "Склад","Заказчик",
    SUM(claim_ct)      AS "Количество отклонений",
    SUM(claim_qty)     AS "Кол-во шт в отклонении",
    SUM(claim_amount)  AS "Сумма в руб. отклонений",
    "USER","Наименование","Тип товара"
FROM dwc_all_defects
GROUP BY
    "ДатаВремя","День","Неделя","Час","Смена",
    "Этап","Категория отклонения","Отклонение",
    "Склад","Заказчик","USER","Наименование","Тип товара")

select * from  BD_UNION
UNION all
select * from kdz_union
union all
select * from dwc_union