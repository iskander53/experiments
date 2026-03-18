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
zup_name as (
--справочник таб номер и имя
select zup, max(name) as name from u group by zup
),
p as (
    --пользователь, который запаковал ГМ и дата операции
    select
        zn.name,
        u.zup,
        o.sku,
        o.event_dttm
    from
        DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
        left join u on o.user = u.login
        left join zup_name zn on u.zup = zn.zup
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
        zn.name,
        u.zup,
        o.sku,
        o.event_dttm
    from
        DWH.EMART.MSK_LOGS_OF_WH_OPERATIONS o
        left join u on o.user = u.login
        left join zup_name zn on u.zup = zn.zup
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
            else 'Неизвестно'
        end as "Категория отклонения",
        case
            when ec.problem_code = 'Излишки' then 'излишек'
            when ec.problem_code in ('Недостача ГМ', 'Недостача') then 'недостача'
            when ec.problem_code in (
                'Заводской брак',
                'Механические повреждения',
                'Некомплект'
            ) then 'повреждение'
            else 'Неизвестно'
        end as "Отклонение",
        ec.problem_code as "Отклонение из источника",
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
        s.TYPE as "Тип товара",
        'Склад' as "Виновник"
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
        and "ДатаВремя" >= '2025-10-01' --and "ДатаВремя" < '2026-02-11'
    group by
        "ДатаВремя",
        "Этап",
        "Категория отклонения",
        "Отклонение",
        "Склад",
        "Заказчик",
        user,
        ec.detail_num,
        s.TYPE,
        ec.problem_code
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
        'Не было движений 30+ дней' as "Отклонение из источника",
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
                zn.name
            ),
            ops.prev_user
        ) as user,
        ops.sku_nm as "Наименование",
        'BOX' as "Тип товара",
        'Склад' as "Виновник"
    from
        ops
        left join prices as pr on ops.sku = pr.sku
        left join u on ops.prev_user = u.login
        left join zup_name zn on u.zup = zn.zup
    where
        ops.defect30flag = 1
        and "ДатаВремя" >= '2025-10-01'
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
        and OPERATION_DT >= '2025-10-01'
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
        "Отклонение" as "Отклонение из источника",
        warehouse_code as "Склад",
        storer as "Заказчик",
        1 as "Количество отклонений",
        sku_cnt as "Кол-во шт в отклонении",
        o.sku_cnt * pr.price as "Сумма в руб. отклонений",
        COALESCE(
            concat(
                u.zup,
                ' ',
                zn.name
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
        end as "Тип товара",
        'Склад' as "Виновник"
    from
        ops o
        left join prices as pr on o.sku = pr.sku
        left join u on o.prev_user = u.login
        left join zup_name zn on u.zup = zn.zup
    where
        1 = 1 --and event_dttm >= '2026-01-01'
        and (
            cell_to ilike '%lost%' --or cell_to ilike '%dolg%'
            or cell_to ilike '%bra%'
            or cell_to ilike '%rack%'
        ) --and cell_to not in ('DOLGI BRAK', 'DOLGI LOST', 'DOLGIUT
        and (cell_to not ilike '%dolg%' or cell_to not ilike '%karant%')
        and sku_cnt > 0
),
lost_supplier as (
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
        'Приемка' as "Этап",
        case
            when (cell_to ilike '%lost%' or cell_to ilike '%karant%') then 'По количеству'
            else 'По качеству'
        end as "Категория отклонения",
        case
            when cell_to ilike '%lost%' then 'недостача'
            when cell_to ilike '%karant%' then 'излишек'
            else 'повреждение'
        end as "Отклонение",
        "Отклонение" as "Отклонение из источника",
        warehouse_code as "Склад",
        storer as "Заказчик",
        1 as "Количество отклонений",
        sku_cnt as "Кол-во шт в отклонении",
        o.sku_cnt * pr.price as "Сумма в руб. отклонений",
        COALESCE(
            concat(
                u.zup,
                ' ',
                zn.name
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
        end as "Тип товара",
        'Поставщик' as "Виновник"
    from
        ops o
        left join prices as pr on o.sku = pr.sku
        left join u on o.prev_user = u.login
        left join zup_name zn on u.zup = zn.zup
    where
        1 = 1 --and event_dttm >= '2026-01-01'
        and (cell_to ilike '%dolg%' or cell_to ilike '%karant%')
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
        'ГМ не отгружено в 1й рейс' as "Отклонение из источника",
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
        'BOX' as "Тип товара",
        'Склад' as "Виновник"
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
    union all
    select
        distinct *
    from
    lost_supplier
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
            --WHEN o.TYPE = 'UNKNOWN'                                      THEN 'Неизвестно'
            WHEN o.TYPE IN ('CARGO_PLACE','CARGO_PICK', 'CARGO_SHIP') THEN 'Отгрузка'
            ELSE o.TYPE
        END AS stage_curr

    FROM DWH.SANDBOX.LA_WH_OPERATIONS_KDZ_DWC o
    -- лучше так, чтобы поймать "дефект в 2026", даже если последнее движение было в конце 2025
    WHERE o.OPERATION_DT >= DATEADD('day', -30, '2026-01-01'::timestamp)
      AND o.SOURCE = 'KDZ'
      AND o.TYPE is not null
      AND o.TYPE != 'UNKNOWN'
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
            ELSE o.prev_type
        END AS "Этап",

        'По количеству' AS "Категория отклонения",
        'недостача'     AS "Отклонение",
        'недостача'     AS "Отклонение из источника",
        'KDZ' AS "Склад",
        COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        'Склад' AS "Виновник", ---добавил Ленар 12 марта
        o.qty_eff                  AS claim_qty,
        COALESCE(o.price_eff, 0)   AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,

        COALESCE(o.prev_username, o.USERNAME) AS "USER",

        o.DETAILNAME AS "Наименование",
        o.ITEM_TYPE  AS "Тип товара",
        o.OBJECTCODE::VARCHAR AS OBJECTCODE
    FROM kdz_ops_all o
    WHERE o.TOPLACECODE IN ('888888', 'LOST')
      AND o.OPERATION_DT >= '2026-01-01'::timestamp
      AND o.prev_type is not null
      AND o.prev_type != 'UNKNOWN'
),
----рекламации 
kdz_reclamation_events AS (
SELECT
    ret.CREATEDATE AS "ДатаВремя",
    DATE_TRUNC('day', ret.CREATEDATE)::date AS "День",
    DATEADD('day', -(DAYOFWEEKISO(ret.CREATEDATE) - 1), DATE_TRUNC('day', ret.CREATEDATE))::date AS "Неделя",
    DATE_PART('hour', ret.CREATEDATE) AS "Час",
    CASE WHEN DATE_PART('hour', ret.CREATEDATE) BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",


    CASE
        WHEN r.REASONID IN (435,425,4,11,102,103,432,8,411,436) THEN 'Приемка'
        WHEN r.REASONID IN (101,431) THEN 'Получатель'
        ELSE 'Упаковка'
    END AS "Этап",

    CASE
    WHEN r.REASONID IN (412, 104, 434, 425, 4, 106, 432,426)
        THEN 'По качеству'
    ELSE 'По количеству'
END AS "Категория отклонения",
    CASE
        WHEN r.REASONID IN (436,431) THEN 'Неизвестно'
        WHEN r.REASONID IN (12,427) THEN 'пересорт'
        WHEN r.REASONID IN (435,11, 103,102,107,105,111,9,433,110,109) THEN 'недостача'
        WHEN r.REASONID IN(108) THEN 'излишек'
        WHEN r.REASONID IN (426,4,106) THEN 'брак'
        WHEN r.REASONID IN (425,411) THEN 'контрафакт'
        WHEN r.REASONID IN (412,104,434,432) THEN 'повреждение'
        WHEN r.REASONID = 101 THEN 'Безусловный возврат'
        ELSE 'Неизвестно'
    END AS "Отклонение",
    "Отклонение" as "Отклонение из источника",
    'KDZ' AS "Склад",
    COALESCE(g.CUSTOMERNAME, 'EMEX') AS "Заказчик",

    CASE
        WHEN r.REASONID IN (435,425,4,11,102,103,432,8,411,436,426) THEN 'Поставщик'
        WHEN r.REASONID IN (101,431) THEN 'Получатель'
        ELSE 'Склад'
    END AS "Виновник",
    COALESCE(g.qty_eff, 1) AS claim_qty,
COALESCE(g.price_eff, 0) AS unit_price,
COALESCE(g.qty_eff, 1) * COALESCE(g.price_eff, 0) AS claim_amount,

    g.USERNAME AS "USER",
    g.DETAILNAME AS "Наименование",
    g.ITEM_TYPE AS "Тип товара",

    g.OBJECTCODE::VARCHAR AS OBJECTCODE

FROM dwh.ods_msk_online_dbo.reclamation r
---LEFT JOIN dwh.ods_msk_online_dbo.reclamationtexts rt
  ---     ON r.reasonid = rt.reclamationtextid
LEFT JOIN dwh.ods_msk_emexmain_dbo.returns ret
       ON r.RETURNID = ret.ID
       LEFT JOIN kdz_ops_gaps g
    ON g.SUB_ID::VARCHAR = r.ORDERDETAILSUBID::VARCHAR
   AND g.OPERATION_DT <=  r.LASTMODIFIED 
WHERE ret.CREATEDATE >= '2026-01-01'
  AND r.LASTMODIFIED >= '2026-01-01'
  AND r.DELETED_FLG = FALSE
  AND ret.DELETED_FLG = FALSE
  AND r.REASONID IN (
      12, 435, 101, 107, 426, 105, 425, 111, 412, 4, 11, 9, 108, 102,
      104, 427, 106, 103, 433, 436, 110, 434, 431, 432, 109, 8, 411
  )   QUALIFY ROW_NUMBER() OVER (
    PARTITION BY r.RECLAMATIONID
    ORDER BY g.OPERATION_DT DESC
) = 1),

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
        'Не было движений 30+ дней' as "Отклонение из источника",
        'KDZ' AS "Склад",
        COALESCE(o.CUSTOMERNAME, 'EMEX') AS "Заказчик",
        'Склад' AS "Виновник", ---добавил Ленар 12 марта
        o.qty_eff                    AS claim_qty,
        COALESCE(o.price_eff, 0)     AS unit_price,
        o.qty_eff * COALESCE(o.price_eff, 0) AS claim_amount,

        o.USERNAME AS "USER",

        o.DETAILNAME AS "Наименование",
        o.ITEM_TYPE  AS "Тип товара",
       o.OBJECTCODE::VARCHAR AS OBJECTCODE
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
base_operations AS (
    SELECT
        t.OBJECTCODE,
        st.DETAILID,
        t.OBJECTTYPEID,
        CASE
            WHEN t.OBJECTTYPEID = 1 THEN 'Позиция'
            WHEN t.OBJECTTYPEID = 2 THEN 'Тара'
            WHEN t.OBJECTTYPEID = 3 THEN 'Коробка'
            WHEN t.OBJECTTYPEID = 4 THEN 'Внут.тара'
            WHEN t.OBJECTTYPEID = 5 THEN 'Возврат'
        END AS object_type,

        CASE
            WHEN t.shippingdate    IS NOT NULL THEN 'SHIPPING'
            WHEN t.packingdate     IS NOT NULL THEN 'PACK'
            WHEN t.pickingdate     IS NOT NULL THEN 'PICK'
            WHEN t.placementdate   IS NOT NULL THEN 'PLACE'
            WHEN t.sortingzonedate IS NOT NULL THEN 'SORT'
            WHEN t.repackdate      IS NOT NULL THEN 'REPACK'
            WHEN t.expertdate      IS NOT NULL THEN 'EXPERTISE'
            WHEN t.receiptdate     IS NOT NULL THEN 'RECEIPTING'
            WHEN t.placementplace = t.receiptplace THEN 'INVENTORY'
            ELSE 'UNKNOWN'
        END AS current_stage,

        CASE
            WHEN t.shippingdate    IS NOT NULL THEN t.shippinguserid
            WHEN t.packingdate     IS NOT NULL THEN t.packinguserid
            WHEN t.pickingdate     IS NOT NULL THEN t.pickinguserid
            WHEN t.placementdate   IS NOT NULL THEN t.placementuserid
            WHEN t.sortingzonedate IS NOT NULL THEN t.sortingzoneuserid
            WHEN t.repackdate      IS NOT NULL THEN t.repackuserid
            WHEN t.expertdate      IS NOT NULL THEN t.expertuserid
            WHEN t.receiptdate     IS NOT NULL THEN t.receiptuserid
            ELSE NULL
        END AS current_userid,

        CASE
            WHEN t.shippingdate    IS NOT NULL THEN t.shippingdate
            WHEN t.packingdate     IS NOT NULL THEN t.packingdate
            WHEN t.pickingdate     IS NOT NULL THEN t.pickingdate
            WHEN t.placementdate   IS NOT NULL THEN t.placementdate
            WHEN t.sortingzonedate IS NOT NULL THEN t.sortingzonedate
            WHEN t.repackdate      IS NOT NULL THEN t.repackdate
            WHEN t.expertdate      IS NOT NULL THEN t.expertdate
            WHEN t.receiptdate     IS NOT NULL THEN t.receiptdate
            ELSE NULL
        END AS current_stage_dt,

        t.RECEIPTUSERID,
        t.RECEIPTDATE,
        t.EXPERTUSERID,
        t.EXPERTDATE,
        t.SORTINGZONEUSERID,
        t.SORTINGZONEDATE,
        t.PLACEMENTUSERID,
        t.PLACEMENTDATE,
        t.PICKINGUSERID,
        t.PICKINGDATE,
        t.PACKINGUSERID,
        t.PACKINGDATE,
        t.SHIPPINGUSERID,
        t.SHIPPINGDATE,
        t.REPACKUSERID,
        t.REPACKDATE,

        d.DETAILNAME,
        idetails.DETAILPRICEBUYRUR,
        st.PlaceId AS CurrentPlace
    FROM DWH.ODS_MSK_STOREDWH_MOTIVATION.OPERATIONS t
    LEFT JOIN DWH.ODS_MSK_EMEXWMS_STORAGE.STOCK st
        ON t.OBJECTCODE = st.CODE
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.INVOICESDETAILS idetails
        ON TO_VARCHAR(t.OBJECTKEY) = TO_VARCHAR(idetails.ORDERDETAILSUBID)
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.CUSTOMERORDERSDETAILS cod
        ON CAST(REGEXP_REPLACE(t.OBJECTCODE::varchar, '^\\*\\d{4}|/.*$', '') AS varchar) = cod.ORDERDETAILSUBID::varchar
    LEFT JOIN DWH.ODS_MSK_EMEXMAIN_DBO.DETAILS d
        ON cod.DETAILID = d.DETAILID
    WHERE t.RECEIPTDATE >= '2026-01-01'
      AND t.DELETED_FLG = FALSE
    AND t.OBJECTCODE LIKE '*%' 
   --- or t.OBJECTCODE not LIKE '.%'
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY t.OBJECTCODE
        ORDER BY t.RECEIPTDATE DESC
    ) = 1
),

moving AS (
    SELECT
        UNITCODE AS OBJECTCODE,
        ITEM_TYPE,
        TYPE
    FROM DWH.ODS_MSK_EMEXTRACK_STORAGE.V_MOVING
    WHERE date >= '2026-01-01'
      AND TOPLACECODE NOT LIKE '(%'
      AND TOPLACECODE NOT LIKE 'РСЦ%'
      AND UNITCODE NOT LIKE '.42%'
      AND OPERATIONTYPEID IN (1,2)
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY UNITCODE
        ORDER BY date DESC
    ) = 1
),

reject_data AS (
    SELECT
        rd.CODE,
        rdr.Reason,
        rd.QUANTITY
    FROM DWH.ODS_MSK_EMEXWMS_RECEIPT.RECEIPTDETAILREJECT rdr
    JOIN DWH.ODS_MSK_EMEXWMS_RECEIPT.RECEIPTDETAIL rd
        ON rd.RECEIPTDETAILID = rdr.RECEIPTDETAILID
),
defect_flags_kdz AS (
    SELECT
        op.OBJECTCODE,
        op.DETAILNAME,
        m.item_type,
        op.DETAILPRICEBUYRUR,
        r.QUANTITY AS claim_ct,
        TRY_CAST(SUBSTR(SUBSTR(op.OBJECTCODE, 1, 5), 4, 2) AS INTEGER) AS item_qty,

        op.current_stage,
        op.current_stage_dt AS IncomeDate,

        CASE WHEN COALESCE(op.PLACEMENTDATE, CURRENT_TIMESTAMP()) > DATEADD(HOUR, 24, op.RECEIPTDATE) THEN 1 ELSE 0 END AS d13,
        CASE WHEN (DATEDIFF('mi', op.PICKINGDATE, op.SHIPPINGDATE)) / 60.0 > 24 THEN 1 ELSE 0 END AS d16,
        CASE WHEN op.CurrentPlace = 3550 THEN 1 ELSE 0 END AS d12,
        CASE WHEN op.CurrentPlace = 2154 THEN 1 ELSE 0 END AS d18,
        CASE WHEN r.Reason ILIKE '%Излишек%' THEN 1 ELSE 0 END AS d11,
        CASE WHEN op.CurrentPlace = 20 THEN 1 ELSE 0 END AS d26,
----WHEN r.REASONID IN (12,427) THEN 1 ELSE 0 END AS d27, ----'пересорт'
        CASE WHEN r.Reason ILIKE '%Повреждение%' THEN 1 ELSE 0 END AS d21,
        CASE WHEN r.Reason ILIKE '%маркиров%' THEN 1 ELSE 0 END AS d22,
        CASE WHEN r.Reason ILIKE '%Недостач%' THEN 1 ELSE 0 END AS d23,
        CASE WHEN r.Reason ILIKE '%Отказ%' THEN 1 ELSE 0 END AS d24,
        CASE WHEN r.Reason ILIKE '%Отмен%' THEN 1 ELSE 0 END AS d25,
/*
        CASE
            WHEN op.RECEIPTDATE IS NOT NULL
             AND op.PLACEMENTDATE IS NULL
             AND DATEDIFF('day', op.RECEIPTDATE, CURRENT_DATE()) >= 30
            THEN 1 ELSE 0
        END AS d_stuck_place,

        CASE
            WHEN op.PICKINGDATE IS NOT NULL
             AND op.PACKINGDATE IS NULL
             AND DATEDIFF('day', op.PICKINGDATE, CURRENT_DATE()) >= 30
            THEN 1 ELSE 0
        END AS d_stuck_pick,

        CASE
            WHEN op.PACKINGDATE IS NOT NULL
             AND op.SHIPPINGDATE IS NULL
             AND DATEDIFF('day', op.PACKINGDATE, CURRENT_DATE()) >= 30
            THEN 1 ELSE 0
        END AS d_stuck_pack
        */
    FROM base_operations op
    LEFT JOIN reject_data r
        ON op.OBJECTCODE = r.CODE
    LEFT JOIN moving m
        ON op.objectcode = m.objectcode
),

source_kdz_detail AS (
    SELECT
        OBJECTCODE,
        item_type,
        DETAILNAME,
        DATE_TRUNC('HOUR', IncomeDate) AS "ДатаВремя",
        DATE_TRUNC('DAY', IncomeDate) AS "День",
        DATEADD('DAY', -(DAYOFWEEKISO(IncomeDate) - 1), DATE_TRUNC('DAY', IncomeDate)) AS "Неделя",
        DATE_PART('HOUR', IncomeDate) AS "Час",
        current_stage AS stage,
        type,
        problem_code,
        DETAILPRICEBUYRUR AS claim_price,
        claim_ct,
        COALESCE(NULLIF(item_qty, 0), 1) AS item_qty,
        'EMEX' AS storerkey,
        'KDZ' AS sklad
    FROM (
        SELECT *, 'Lost' AS type, 'Потери' AS problem_code
        FROM defect_flags_kdz
        WHERE d12 = 1

        UNION ALL
        SELECT *, 'Error' AS type, 'Излишки' AS problem_code
        FROM defect_flags_kdz
        WHERE d11 = 1

        UNION ALL
        SELECT *, 'Error' AS type, 'Потеряно при подборе' AS problem_code
        FROM defect_flags_kdz
        WHERE d26 = 1

        UNION ALL
        SELECT *, 'Error' AS type, 'Повреждение' AS problem_code
        FROM defect_flags_kdz
        WHERE d21 = 1

        UNION ALL
        SELECT *, 'Error' AS type, 'Без маркировки' AS problem_code
        FROM defect_flags_kdz
        WHERE d22 = 1

        UNION ALL
        SELECT *, 'Error' AS type, 'Недостача' AS problem_code
        FROM defect_flags_kdz
        WHERE d23 = 1
    ) d
),

kdz_sup_def AS (
    SELECT
        "ДатаВремя",
        "День",
        "Неделя",
        "Час",
        CASE WHEN "Час" BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",
        'Приемка' AS "Этап",

        CASE
            WHEN problem_code IN ('Повреждение', 'Без маркировки') THEN 'По качеству'
            ELSE 'По количеству'
        END AS "Категория отклонения",

        CASE
            WHEN problem_code = 'Потери' THEN 'недостача'
            WHEN problem_code = 'Излишки' THEN 'излишек'
            WHEN problem_code = 'Потеряно при подборе' THEN 'недостача'
            WHEN problem_code = 'Повреждение' THEN 'повреждение'
            WHEN problem_code = 'Без маркировки' THEN 'повреждение упаковки'
            WHEN problem_code = 'Недостача' THEN 'недостача'
            ELSE problem_code
        END AS "Отклонение",
        problem_code as "Отклонение из источника",
        sklad AS "Склад",
        storerkey AS "Заказчик",
        'Поставщик' AS "Виновник",

        COALESCE(claim_ct, item_qty, 1) AS claim_qty,
        COALESCE(claim_price, 0) AS unit_price,
        COALESCE(claim_price, 0) * COALESCE(claim_ct, item_qty, 1) AS claim_amount,
        NULL::VARCHAR AS "USER",
        DETAILNAME AS "Наименование",
        ITEM_TYPE AS "Тип товара",
        OBJECTCODE::VARCHAR AS OBJECTCODE
    FROM source_kdz_detail
),
all_defects_kdz AS (
    SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_qty, unit_price, claim_amount,
        "USER","Наименование","Тип товара",
        OBJECTCODE
    FROM kdz_defect_events

    UNION ALL

    SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_qty, unit_price, claim_amount,
        "USER","Наименование","Тип товара",
        OBJECTCODE
    FROM kdz_time_defect_events

    UNION ALL

    SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_qty, unit_price, claim_amount,
        "USER","Наименование","Тип товара",
        OBJECTCODE
    FROM kdz_reclamation_events

    UNION ALL

    SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_qty, unit_price, claim_amount,
        "USER","Наименование","Тип товара",
        OBJECTCODE
    FROM kdz_sup_def

),

kdz_union as (
SELECT
    "ДатаВремя",
    "День",
    "Неделя",
    "Час",
    "Смена",
    "Этап",
    "Категория отклонения",
    "Отклонение",
    "Отклонение из источника",
    "Склад",
    "Заказчик",
    SUM(claim_amount)         AS "Сумма в руб. отклонений",
    SUM(claim_qty)            AS "Кол-во шт в отклонении",
    COUNT(DISTINCT OBJECTCODE) AS "Количество отклонений",
    "USER",
    "Наименование",
    "Тип товара",
    "Виновник"  ---добавил Ленар 12 марта
    --,OBJECTCODE
FROM all_defects_kdz
GROUP BY
    "ДатаВремя",
    "День",
    "Неделя",
    "Час",
    "Смена",
    "Этап",
    "Категория отклонения",
    "Отклонение",
    "Отклонение из источника",
    "Склад",
    "Заказчик",
    "USER",
    "Наименование",
    "Тип товара",
    --OBJECTCODE,
    "Виновник"),  ---добавил Ленар 12 марта
    ---------------------------------------------------------------------------DWC
 
user_mapping AS (
    SELECT USER_ID, dwc_id
    FROM DWH.REPLICA_VDOCKERPSQL1_EMEXUAE.V_LKP_LKD_API_TOKENS
    WHERE dwc_id IS NOT NULL
),

cm_parcel AS (
    SELECT *
    FROM DWH.ODS_UAE_RSC.V_CORE_MOVE
    WHERE operation IN ('picking', 'wrapping')
      AND entity_subtype IN ('Parcel', 'Box')
      AND event_dttm >= '2026-01-01'
),

customers AS (
    SELECT
        cd.ORDERDETAILSUBID,
        c.customerlogo,
        c.CUSTOMERNAME,
        cd.orderid
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.CUSTOMERORDERSDETAILS cd
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.CUSTOMERORDERS co ON cd.orderid = co.orderid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.CUSTOMERS c ON co.customerid = c.customerid
    GROUP BY 1, 2, 3, 4
),

pack_boxes AS (
    SELECT
        substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) AS objectcode,
        substring(object_to, position('(' IN object_to) + 1) AS object_to
    FROM cm_parcel
    WHERE event_dttm >= '2026-01-01'
      AND operation = 'wrapping'
      AND ENTITY_SUBTYPE = 'Parcel'
    GROUP BY 1, 2
),

wh AS (
    SELECT
        CONCAT(wol.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        CASE
            WHEN OPERATION LIKE '%_%' THEN SPLIT_PART(OPERATION, '_', 1)
            ELSE OPERATION
        END AS type,
        wol.EVENTDATE AS dt,
        wol.EVENTUSER::varchar AS user_id,
        rd.DETAILID,
        rd.RECEIPTSDETAILID,
          id.DETAILQUANTITY   AS detail_qty,
        id.DETAILPRICEBUY   AS detail_price,
        rd.detailquantity AS qty,
        wol.HOSTNAME,
        NULL AS object_from,
        CASE WHEN type = 'PACKING' THEN pb.object_to ELSE NULL END AS object_to,
        NULL AS loc_from,
        NULL AS loc_to,
        CASE
            WHEN rd.BITBIG = TRUE  THEN 'BIG'
            WHEN rd.SORTTYPEID = 1 THEN 'SMALL'
            WHEN rd.SORTTYPEID = 2 THEN 'NORMAL'
            WHEN rd.SORTTYPEID = 3 THEN 'NORMAL'
        END AS item_type,
        cu.customerlogo, cu.CUSTOMERNAME, cu.orderid,
        des.destinationlogo, sup.SUPPLIERLOGO,
        i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.V_TBL_WAREHOUSE_OPERATIONLOG wol
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd ON wol.receiptdetailid = rd.RECEIPTSDETAILID
    LEFT JOIN customers cu ON wol.orderdetailsubid = cu.orderdetailsubid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.DESTS des ON rd.destinationid = des.destinationid
    LEFT JOIN pack_boxes pb ON CONCAT(wol.ORDERDETAILSUBID, '_', rd.portion) = pb.objectcode
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE eventdate >= '2026-01-01'
      AND OPERATION NOT LIKE '%BOX%'
      AND OPERATION NOT LIKE '%SCAN%'
      AND USER_ID != 44
),

rc AS (
    SELECT
        CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        'RECEIPTING' AS type,
        rd.RECEIPTSDETAILSDATE AS dt,
        rd.ReceiptUserId::varchar AS user_id,
        rd.DETAILID,
        rd.RECEIPTSDETAILID,
        rd.detailquantity AS qty,
        id.DETAILQUANTITY   AS detail_qty,
        id.DETAILPRICEBUY   AS detail_price,
        rd.RECEIPTPLACE AS HOSTNAME,
        NULL AS object_from, NULL AS object_to, NULL AS loc_from, NULL AS loc_to,
        CASE
            WHEN rd.BITBIG = TRUE  THEN 'BIG'
            WHEN rd.SORTTYPEID = 1 THEN 'SMALL'
            WHEN rd.SORTTYPEID = 2 THEN 'NORMAL'
            WHEN rd.SORTTYPEID = 3 THEN 'NORMAL'
        END AS item_type,
        cu.customerlogo, cu.CUSTOMERNAME, cu.orderid,
        des.destinationlogo, sup.SUPPLIERLOGO,
        i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
    LEFT JOIN customers cu ON rd.orderdetailsubid = cu.orderdetailsubid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.DESTS des ON rd.destinationid = des.destinationid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE RECEIPTSDETAILSDATE >= '2026-01-01'
      AND rd.DELETED_FLG = FALSE
      AND USER_ID != 44
),

pc AS (
    SELECT
        substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) AS objectcode,
        'PICK' AS type,
        cm.event_dttm AS dt,
        u.dwc_id::varchar AS user_id,
        rd.DETAILID, rd.RECEIPTSDETAILID,
        entity_content_quantity AS qty,
         id.DETAILQUANTITY   AS detail_qty,
        id.DETAILPRICEBUY   AS detail_price,
        NULL AS HOSTNAME, NULL AS object_from,
        substring(object_to, position('(' IN object_to) + 1) AS object_to,
        cm.CELLFROM_CODE AS loc_from, cm.CELLTO_CODE AS loc_to,
        CASE
            WHEN rd.BITBIG = TRUE  THEN 'BIG'
            WHEN rd.SORTTYPEID = 1 THEN 'SMALL'
            WHEN rd.SORTTYPEID = 2 THEN 'NORMAL'
            WHEN rd.SORTTYPEID = 3 THEN 'NORMAL'
        END AS ITEM_TYPE,
        left(cm.destination, 4) AS customerlogo, NULL AS customername, NULL AS orderid,
        right(cm.destination, 4) AS destinationlogo,
        sup.SUPPLIERLOGO, i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM cm_parcel cm
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
        ON substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) = concat(rd.orderdetailsubid, '_', rd.portion)
    LEFT JOIN user_mapping u ON cm.user_id = u.user_id
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE cm.operation = 'picking'
      AND cm.entity_subtype = 'Parcel'
      AND cm.PARENT_ID IS NOT NULL
      AND cm.object_to LIKE 'TR_%'
      AND cm.event_dttm >= '2026-01-01'
      AND u.dwc_id != 44
),

pc_sm AS (
    SELECT
        substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) AS objectcode,
        'PICK' AS type,
        cm.event_dttm AS dt,
        u.dwc_id::varchar AS user_id,
        rd.DETAILID, rd.RECEIPTSDETAILID,
        entity_content_quantity AS qty,
         id.DETAILQUANTITY   AS detail_qty,
        id.DETAILPRICEBUY   AS detail_price,
        NULL AS HOSTNAME,
        substring(object_from, position('(' IN object_from) + 1) AS object_from,
        substring(object_to, position('(' IN object_to) + 1) AS object_to,
        cm.CELLFROM_CODE AS loc_from, cm.CELLTO_CODE AS loc_to,
        CASE
            WHEN rd.BITBIG = TRUE  THEN 'BIG'
            WHEN rd.SORTTYPEID = 1 THEN 'SMALL'
            WHEN rd.SORTTYPEID = 2 THEN 'NORMAL'
            WHEN rd.SORTTYPEID = 3 THEN 'NORMAL'
        END AS ITEM_TYPE,
        left(cm.destination, 4) AS customerlogo, NULL AS customername, NULL AS orderid,
        right(cm.destination, 4) AS destinationlogo,
        sup.SUPPLIERLOGO, i.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM cm_parcel cm
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
        ON substring(entity_barcode, 6, 8) || '_' || substring(entity_barcode, 15) = concat(rd.orderdetailsubid, '_', rd.portion)
    LEFT JOIN user_mapping u ON cm.user_id = u.user_id
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESDETAILS id ON rd.invoicesdetailid = id.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON id.invoiceid = i.invoiceid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON i.supplierid = sup.supplierid
    WHERE cm.operation = 'picking'
      AND cm.entity_subtype = 'Parcel'
      AND cm.PARENT_ID IS NOT NULL
      AND cm.object_to NOT LIKE 'TR_%'
      AND cm.event_dttm >= '2026-01-01'
      AND u.dwc_id != 44
    GROUP BY ALL
),

ops_dwc AS (
    SELECT objectcode, type, dt, user_id, DETAILID, RECEIPTSDETAILID, qty,detail_qty, detail_price,
           HOSTNAME, object_from, object_to, loc_from, loc_to, item_type,
           customerlogo, CUSTOMERNAME, orderid, destinationlogo, SUPPLIERLOGO,
           invoicenumber, Invoice_Receipt_DT FROM wh
    UNION ALL
    SELECT objectcode, type, dt, user_id, DETAILID, RECEIPTSDETAILID, qty,detail_qty, detail_price,
           HOSTNAME, object_from, object_to, loc_from, loc_to, ITEM_TYPE,
           customerlogo, customername, orderid, destinationlogo, SUPPLIERLOGO,
           invoicenumber, Invoice_Receipt_DT FROM pc
    UNION ALL
    SELECT objectcode, type, dt, user_id, DETAILID, RECEIPTSDETAILID, qty,detail_qty, detail_price,
           HOSTNAME, object_from, object_to, loc_from, loc_to, ITEM_TYPE,
           customerlogo, customername, orderid, destinationlogo, SUPPLIERLOGO,
           invoicenumber, Invoice_Receipt_DT FROM pc_sm
    UNION ALL
    SELECT objectcode, type, dt, user_id, DETAILID, RECEIPTSDETAILID, qty,detail_qty, detail_price,
           HOSTNAME, object_from, object_to, loc_from, loc_to, item_type,
           customerlogo, CUSTOMERNAME, orderid, destinationlogo, SUPPLIERLOGO,
           invoicenumber, Invoice_Receipt_DT FROM rc
),

ops_si AS (
    SELECT
        objectcode,
        CASE
            WHEN type = 'READY'     THEN 'PLACE'
            WHEN type = 'SORTING'   THEN 'SORT'
            WHEN type = 'PACKING'   THEN 'PACK'
            WHEN type = 'REPACKING' THEN 'REPACK'
            ELSE type
        END AS TYPE,
        DT, USER_ID, DETAILID, RECEIPTSDETAILID, qty, detail_qty, detail_price, HOSTNAME,
        object_from, object_to, loc_from, loc_to,
        LAST_VALUE(ITEM_TYPE IGNORE NULLS) OVER (
            PARTITION BY objectcode
            ORDER BY DT DESC, type
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
        ) AS ITEM_TYPE,
        customerlogo, CUSTOMERNAME, orderid, destinationlogo, SUPPLIERLOGO,
        invoicenumber, Invoice_Receipt_DT
    FROM ops_dwc
    WHERE USER_ID != '44'
),

box_customers AS (
    SELECT box_id, BOX_CUSTOMER_LOGO AS customerlogo, BOX_DESTINATION_LOGO AS destinationlogo
    FROM DWH.EMART.DWC_EXPEDITION_BOXESTRANSIT_AND_SHIPMENT
),

ops_box AS (
    SELECT
        bt.BOX_ID::varchar AS objectcode,
        CASE
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.closed' THEN 'PACK_NEW_BOX'
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.sorted' THEN 'CARGO_PLACE'
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.picked' THEN 'CARGO_PICK'
            WHEN bt.EVENT_NM = 'dwc.expedition.boxestransit.taken'  THEN 'CARGO_SHIP'
        END AS type,
        bt.EVENT_DTTM AS dt, bt.USER_ID::varchar AS USER_ID,
        NULL AS DETAILID, NULL AS RECEIPTSDETAILID, NULL AS qty,  NULL AS detail_qty, NULL AS detail_price,
        bt.place_id AS HOSTNAME, NULL AS object_from, NULL AS object_to,
        NULL AS loc_from, bt.place_id AS loc_to, 'BOX' AS ITEM_TYPE,
        bc.customerlogo, NULL AS CUSTOMERNAME, NULL AS orderid,
        bc.destinationlogo, NULL AS SUPPLIERLOGO, NULL AS invoicenumber, NULL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_DWC.V_DWC_EXPEDITION_BOXESTRANSIT bt
    LEFT JOIN box_customers bc ON bt.box_id = bc.box_id
    WHERE EVENT_DTTM >= '2026-01-01' AND USER_ID != 44

    UNION ALL

    SELECT
        substring(entity_barcode, position('(' IN entity_barcode) + 1) AS objectcode,
        'PICK_BOX' AS type,
        cm.event_dttm AS dt, u.dwc_id::varchar AS user_id,
        NULL AS DETAILID, NULL AS RECEIPTSDETAILID, NULL AS qty,  NULL AS detail_qty, NULL AS detail_price,
        NULL AS HOSTNAME, NULL AS object_from, NULL AS object_to,
        cm.CELLFROM_CODE AS loc_from, cm.CELLTO_CODE AS loc_to, 'BOX' AS ITEM_TYPE,
        bc.customerlogo, NULL AS CUSTOMERNAME, NULL AS orderid,
        bc.destinationlogo, NULL AS SUPPLIERLOGO, NULL AS invoicenumber, NULL AS Invoice_Receipt_DT
    FROM cm_parcel cm
    LEFT JOIN box_customers bc
        ON substring(entity_barcode, position('(' IN entity_barcode) + 1) = bc.box_id
    LEFT JOIN user_mapping u ON cm.user_id = u.user_id
    WHERE cm.operation = 'picking'
      AND cm.entity_subtype = 'Box'
      AND cm.PARENT_ID IS NOT NULL
      AND cm.object_to LIKE 'TR_%'
      AND cm.event_dttm >= '2026-01-01'
      AND u.dwc_id != 44
),

det AS (
    SELECT d.detailnum, m.makelogo, m.makename, d.detailid, d.detailnamerus, d.detailname
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.DETAILS d
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.MAKES m ON d.makeid = m.makeid
),

inb AS (
    SELECT
        CASE
            WHEN left(barcode, 1) = '*' OR left(barcode, 1) = '!'
                THEN replace(substring(ind.barcode, 6), '/', '_')
            ELSE substring(barcode, position('(' IN barcode) + 1)
        END AS objectcode,
        ind.portioncode, ind.quantity, det.detailid,
        ind.inbound_detail_id, inh.inbound_id,
        substring(inh.code, 10) AS code, inh.supplier_code
    FROM DWH.REPLICA_VDOCKERPSQL1_EMEXUAE.V_LKP_DOCUMENTS_INBOUND_DETAILS ind
    LEFT JOIN det ON ind.detailnumber = det.detailnum AND ind.makename = det.makename
    LEFT JOIN DWH.REPLICA_VDOCKERPSQL1_EMEXUAE.V_LKP_DOCUMENTS_INBOUND_HEADS inh
        ON ind.inbound_id = inh.inbound_id
    WHERE ind.state_date >= '2026-01-01' AND left(inh.code, 3) = 'DWC'
),

stoc_invoices AS (
    SELECT si.invoiceid, sid.invoicesdetailid, sid.orderdetailsubid, sid.quantityscan, si.invoicenumber
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.STOCINVOICES si
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.STOCINVOICESDETAILS sid ON si.invoiceid = sid.invoiceid
),

ops_stoc AS (
    SELECT
        CASE
            WHEN left(inb.objectcode, 3) = 'STK'
                THEN replace(substr(inb.objectcode, 4), '/', '_')
            ELSE inb.objectcode::varchar
        END AS objectcode,
        CASE
            WHEN OPERATIONID = 1 THEN 'STOCK_RECEIPTING'
            WHEN OPERATIONID = 2 THEN 'STOCK_PLACE'
            WHEN OPERATIONID = 4 THEN 'STOCK_PICK'
            WHEN OPERATIONID = 5 THEN 'STOCK_INVENTORY'
            ELSE 'UNKNOWN'
        END AS type,
        EVENTTIME AS dt, sol.USERID::varchar AS USER_ID,
        inb.detailid AS DETAILID, NULL AS RECEIPTSDETAILID,
        inb.quantity AS qty, NULL AS detail_qty,  NULL AS detail_price, NULL AS HOSTNAME,
        sol.placeid::varchar AS object_from, NULL AS object_to,
        NULL AS loc_from, NULL AS loc_to, 'STOCK' AS ITEM_TYPE,
        NULL AS customerlogo, NULL AS CUSTOMERNAME, NULL AS orderid,
        NULL AS destinationlogo, inb.supplier_code AS SUPPLIERLOGO,
        s.invoicenumber, i.DATEARRIVAL AS Invoice_Receipt_DT
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.V_TBL_STOCOPERATIONLOG sol
    LEFT JOIN inb ON sol.objectid = inb.inbound_detail_id
    LEFT JOIN stoc_invoices s ON inb.code = s.invoiceid AND inb.portioncode = s.invoicesdetailid
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.SUPPLIERS sup ON inb.supplier_code = sup.suppliercode
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICES i ON s.invoiceid = i.invoiceid
    WHERE EVENTTIME >= '2026-01-01' AND sol.USERID != 44
),

fdata AS (
    SELECT * FROM ops_stoc
    UNION ALL SELECT * FROM ops_si
    UNION ALL SELECT * FROM ops_box
),

SOURCE_DWC AS (
    SELECT
        f.OBJECTCODE,
        split_part(f.OBJECTCODE, '_', 1) AS sub_id,
        f.TYPE,
        CASE
            WHEN TYPE = 'RECEIPTING' THEN 0
            WHEN TYPE = 'SORT'       THEN 1
            WHEN TYPE = 'PLACE'      THEN 2
            WHEN TYPE = 'PICK'       THEN 3
            WHEN TYPE = 'PACK'       THEN 4
        END AS TYPE_NUM,
        f.DT,
        WEEKOFYEAR(f.DT) AS week_num,
        lag(f.dt) OVER (PARTITION BY f.USER_ID ORDER BY f.dt) AS prev_dt,
        datediff(second, prev_dt, f.DT) AS ops_time,
        f.USER_ID, u.username,
        f.DETAILID, f.RECEIPTSDETAILID, f.qty, f.qty, f.detail_qty,  f.detail_price,
        det.detailnum,
        coalesce(det.detailnamerus, det.detailname) AS descr,
        f.HOSTNAME, f.object_from, f.object_to, f.loc_from, f.loc_to,
        f.ITEM_TYPE, f.customerlogo, f.CUSTOMERNAME, f.orderid,
        f.destinationlogo, f.SUPPLIERLOGO, det.makelogo, det.MAKENAME,
        invoicenumber, Invoice_Receipt_DT
    FROM fdata f
    LEFT JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.USERS u ON f.USER_ID = u.userid
    LEFT JOIN det ON f.detailid = det.detailid
    WHERE NOT (item_type = 'BIG' AND f.TYPE = 'SORT')
      AND NOT (item_type = 'BIG' AND f.TYPE = 'REPACK')
      AND f.USER_ID != '44'
),

receipt_problems AS (
    SELECT
        CONCAT(rd.ORDERDETAILSUBID, '_', rd.portion) AS objectcode,
        p.ID AS problem_id,
        CASE
            WHEN p.ID IN (4, 6, 7) THEN 'd21'  -- Damaged, Scratches, Rusty
            WHEN p.ID = 10         THEN 'd22'  -- No Barcode/wrong supply
            WHEN p.ID IN (8, 9, 2) THEN 'd24'  -- Refusal, Return, Not allowed
            WHEN p.ID IN (1, 3, 11) THEN 'd25' -- High price, Undefined price, Confirm substitution
            WHEN p.ID = 17         THEN 'd18'  -- No original packaging
        END AS defect_flag
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.RECEIPTSDETAILS rd
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM_LINK l
        ON rd.RECEIPTSDETAILID = l.RECEIPTSDETAILID
    JOIN DWH.ODS_UAE_EMEXMAINUAE_DBO.TBL_RECEIPTDETAILPROBLEM p
        ON l.PROBLEMID = p.ID
    WHERE rd.DELETED_FLG = FALSE
      AND p.DELETED_FLG = FALSE
      AND p.ID NOT IN (-1, -4)
),

receipt_problems_agg AS (
    SELECT
        objectcode,
        MAX(CASE WHEN defect_flag = 'd18' THEN 1 ELSE 0 END) AS rp_d18,
        MAX(CASE WHEN defect_flag = 'd21' THEN 1 ELSE 0 END) AS rp_d21,
        MAX(CASE WHEN defect_flag = 'd22' THEN 1 ELSE 0 END) AS rp_d22,
        MAX(CASE WHEN defect_flag = 'd24' THEN 1 ELSE 0 END) AS rp_d24,
        MAX(CASE WHEN defect_flag = 'd25' THEN 1 ELSE 0 END) AS rp_d25
    FROM receipt_problems
    GROUP BY objectcode
),

/*
excess_data AS (
   SELECT 
        DETAILID,
        MIN(DATEADD) AS excess_dt,   -- берём самую раннюю дату
        SUM(QUANTITY) AS QUANTITY     -- суммируем все излишки по детали
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.INVOICESEXCESS
    WHERE DELETED_FLG = FALSE 
      AND BITCONFIRM = TRUE
      AND QUANTITY > 0
    GROUP BY DETAILID
),
*/
defect_data AS (
    SELECT
        dd.RECEIPTSDETAILID,
        dd.DEFECTDATE,
        dd.DETAILQUANTITY,
        CASE WHEN dd.DEFECTREASONID = 8  THEN 1 ELSE 0 END AS is_damaged,
        CASE WHEN dd.DEFECTREASONID = 25 THEN 1 ELSE 0 END AS is_barcode,
        CASE WHEN dd.DEFECTREASONID = 9  THEN 1 ELSE 0 END AS is_shortage,
        CASE WHEN dd.DEFECTREASONID = 16 THEN 1 ELSE 0 END AS is_refusal,
        CASE WHEN dd.DEFECTREASONID = 20 THEN 1 ELSE 0 END AS is_lost
    FROM DWH.ODS_UAE_EMEXMAINUAE_DBO.DEFECTSDETAILS dd
    WHERE dd.DELETED_FLG = FALSE
      AND dd.DEFECTREASONID IN (8, 25, 9, 16, 20)
),

defect_agg AS (
    SELECT
        RECEIPTSDETAILID,
         MAX(DETAILQUANTITY) as claim_ct,
        MAX(is_damaged)  AS is_damaged,
        MAX(is_barcode)  AS is_barcode,
        MAX(is_shortage) AS is_shortage,
        MAX(is_refusal)  AS is_refusal,
        MAX(is_lost)     AS is_lost,
        MAX(CASE WHEN is_lost = 1 THEN DEFECTDATE END) AS lost_dt
    FROM defect_data
    GROUP BY RECEIPTSDETAILID
),

stage_dates AS (
    SELECT
        OBJECTCODE,
        MAX(CASE WHEN TYPE = 'RECEIPTING' THEN DT END) AS receipt_dt,
        MAX(CASE WHEN TYPE = 'PLACE'      THEN DT END) AS place_dt,
        MAX(CASE WHEN TYPE = 'PICK'       THEN DT END) AS pick_dt,
        MAX(CASE WHEN TYPE = 'PACK'       THEN DT END) AS pack_dt,
        MAX(ITEM_TYPE)          AS item_type,
        MAX(descr)              AS detailname,
        MAX(detailnum)          AS detailnum,
        MAX(makelogo)           AS makelogo,
        MAX(MAKENAME)           AS makename,
        MAX(CUSTOMERNAME)       AS customername,
        MAX(customerlogo)       AS customerlogo,
        MAX(orderid)            AS orderid,
        MAX(destinationlogo)    AS destinationlogo,
        MAX(SUPPLIERLOGO)       AS supplierlogo,
        MAX(invoicenumber)      AS invoicenumber,
        MAX(Invoice_Receipt_DT) AS invoice_receipt_dt,
        MAX(username)           AS employee_name,
        MAX(USER_ID)            AS employee_id,
        MAX(DETAILID)           AS detailid,
        MAX(RECEIPTSDETAILID)   AS receiptsdetailid,
        MAX(detail_qty) as _qty,
        MAX(detail_price) as _price, 
        MAX(HOSTNAME)           AS workstation,
        MAX(loc_from)           AS loc_from,
        MAX(loc_to)             AS loc_to,
        MAX(object_from)        AS object_from,
        MAX(object_to)          AS object_to
    FROM SOURCE_DWC
    WHERE ITEM_TYPE != 'BOX'
    GROUP BY OBJECTCODE
),

defect_flags AS (
    SELECT
        s.*,

        -- d11: излишки — только INVOICESEXCESS
       ----- CASE WHEN ex.DETAILID IS NOT NULL THEN 1 ELSE 0 END AS d11,

        -- d18: контрафакт — только TBL_RECEIPTDETAILPROBLEM (ID=17)
        COALESCE(rp.rp_d18, 0) AS d18,

        -- d21: повреждение — оба источника
        GREATEST(COALESCE(da.is_damaged, 0), COALESCE(rp.rp_d21, 0)) AS d21,

        -- d22: без маркировки — оба источника
        GREATEST(COALESCE(da.is_barcode, 0), COALESCE(rp.rp_d22, 0)) AS d22,

        -- d23: недостача — только DEFECTSDETAILS (9)
        COALESCE(da.is_shortage, 0) AS d23,

        -- d24: отказ — оба источника
        GREATEST(COALESCE(da.is_refusal, 0), COALESCE(rp.rp_d24, 0)) AS d24,

        -- d25: прочее — только TBL_RECEIPTDETAILPROBLEM
        COALESCE(rp.rp_d25, 0) AS d25,

        -- d_lost: потери — только DEFECTSDETAILS (20)
        COALESCE(da.is_lost, 0) AS d_lost,
        -- d_stuck_place: Приняли, но не разместили 30д+
CASE
    WHEN s.receipt_dt IS NOT NULL
     AND s.place_dt IS NULL
     AND DATEDIFF('day', s.receipt_dt, CURRENT_DATE()) >= 30
    THEN 1 ELSE 0
END AS d_stuck_place,

-- d_stuck_pick: Подобрали, но не упаковали 30д+
CASE
    WHEN s.pick_dt IS NOT NULL
     AND s.pack_dt IS NULL
     AND DATEDIFF('day', s.pick_dt, CURRENT_DATE()) >= 30
    THEN 1 ELSE 0
END AS d_stuck_pick,

-- d_stuck_pack: Упаковали, но не отгрузили 30д+
CASE
    WHEN s.pack_dt IS NOT NULL
     AND DATEDIFF('day', s.pack_dt, CURRENT_DATE()) >= 30
    THEN 1 ELSE 0
END AS d_stuck_pack,

        -- дата потери
        da.lost_dt, da.claim_ct

    FROM stage_dates s
    ---LEFT JOIN excess_data          ex ON s.detailid = ex.DETAILID
    LEFT JOIN defect_agg           da ON s.receiptsdetailid = da.RECEIPTSDETAILID
    LEFT JOIN receipt_problems_agg rp ON s.OBJECTCODE = rp.objectcode
),

d as(/*
        CASE
            WHEN s.place_dt IS NOT NULL AND s.receipt_dt IS NOT NULL
             AND DATEDIFF('hour', s.receipt_dt, s.place_dt) > 24
            THEN 1 ELSE 0
        END AS d13,

        -- d16: опоздание отгрузки > 24ч
        CASE
            WHEN s.pack_dt IS NOT NULL AND s.pick_dt IS NOT NULL
             AND DATEDIFF('hour', s.pick_dt, s.pack_dt) > 24
            THEN 1 ELSE 0
        END AS d16,
        
        -- d11: излишки
         -- d11: излишки
        SELECT *, receipt_dt AS income_dt,  'RECEIPTING' AS stage,
               'Error' AS type, 'Излишки' AS problem_code
        FROM defect_flags WHERE d11 = 1
        */
        /*UNION ALL

        -- d18: контрафакт
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Error' AS type, 'Контрафакт' AS problem_code
        FROM defect_flags WHERE d18 = 1
        
        UNION ALL
        */
        -- d21: повреждение
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Error' AS type, 'Повреждение' AS problem_code
        FROM defect_flags WHERE d21 = 1

        UNION ALL

        -- d22: без маркировки
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Error' AS type, 'Без маркировки' AS problem_code
        FROM defect_flags WHERE d22 = 1

        UNION ALL

        -- d23: недостача
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Error' AS type, 'Недостача' AS problem_code
        FROM defect_flags WHERE d23 = 1
       /*
        UNION ALL

        -- d24: отказ
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Error' AS type, 'Отказано в возврате' AS problem_code
        FROM defect_flags WHERE d24 = 1
        
        UNION ALL
        
        -- d25: прочее
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Error' AS type, 'Дефект поставщика' AS problem_code
        FROM defect_flags WHERE d25 = 1
        */
        UNION ALL

        -- d_lost: потери
        SELECT *, COALESCE(lost_dt, receipt_dt) AS income_dt, 'RECEIPTING' AS stage,
               'Lost' AS type, 'Потери' AS problem_code
        FROM defect_flags WHERE d_lost = 1 ),
       /*
        UNION ALL

        -- d_stuck_place: Приняли, но не разместили 30д+
        SELECT *, receipt_dt AS income_dt, 'RECEIPTING' AS stage,
               'Lost' AS type, 'Зависший товар' AS problem_code
        FROM defect_flags WHERE d_stuck_place = 1

        UNION ALL

        -- d_stuck_pick: Подобрали, но не упаковали 30д+
        SELECT *, pick_dt AS income_dt, 'PICK' AS stage,
               'Lost' AS type, 'Зависший товар' AS problem_code
        FROM defect_flags WHERE d_stuck_pick = 1

        UNION ALL

        -- d_stuck_pack: Упаковали, но не отгрузили 30д+
        SELECT *, pack_dt AS income_dt, 'PACK' AS stage,
               'Lost' AS type, 'Зависший товар' AS problem_code
        FROM defect_flags WHERE d_stuck_pack = 1),
       */

SOURCE_DWC_DETAIL AS (
    SELECT
        OBJECTCODE, item_type, detailname, detailnum, makename,
        DATE_TRUNC('HOUR', income_dt)                                                  AS "ДатаВремя",
        DATE_TRUNC('DAY',  income_dt)                                                  AS "День",
        DATEADD('DAY', -(DAYOFWEEKISO(income_dt) - 1), DATE_TRUNC('DAY', income_dt))  AS "Неделя",
        DATE_PART('HOUR', income_dt)                                                   AS "Час",
        stage, employee_name, employee_id, type, problem_code,
        workstation, loc_from, loc_to, object_from, object_to,
        claim_ct::number AS claim_ct,
        _qty           AS claim_qty,
        _price AS claim_price,
        'DWC'  AS sklad,
        'EMEX' AS storerkey
    FROM  d
),

source_dwc_1 as (
SELECT
    OBJECTCODE                              AS "OBJECTCODE",
    detailname                              AS "DETAILNAME",
    detailnum                               AS "Артикул",
    makename                                AS "Бренд",
    item_type                               AS "ITEM_TYPE",
    "ДатаВремя",
    "День",
    "Неделя",
    "Час",

    CASE
        WHEN stage = 'RECEIPTING' THEN 'Приемка'
        WHEN stage = 'PICK'       THEN 'Подбор'
        WHEN stage = 'PLACE'      THEN 'Размещение'
        WHEN stage = 'SORT'       THEN 'Сортировка'
        WHEN stage = 'PACK'       THEN 'Упаковка'
        ELSE 'Неизвестно'
    END                                     AS "Этап",

     CASE
      ---  WHEN problem_code = 'Излишки'             THEN 'По количеству'
       --- WHEN problem_code = 'Контрафакт'          THEN 'другое'
        WHEN problem_code = 'Повреждение'         THEN 'По качеству'
        WHEN problem_code = 'Без маркировки'      THEN 'По качеству'
        WHEN problem_code = 'Недостача'           THEN 'По количеству'
        ---WHEN problem_code = 'Отказано в возврате' THEN 'другое'
       --- WHEN problem_code = 'Дефект поставщика'   THEN 'другое'
        WHEN problem_code = 'Потери'              THEN 'По количеству'
        WHEN problem_code = 'Зависший товар' THEN 'По количеству'
        ELSE problem_code
    END                                    AS "Категория отклонения",

    CASE
       --- WHEN problem_code = 'Излишки'             THEN 'излишек'
        WHEN problem_code = 'Контрафакт'          THEN 'другое'
        WHEN problem_code = 'Повреждение'         THEN 'повреждение'
        WHEN problem_code = 'Без маркировки'      THEN 'повреждение упаковки'
        WHEN problem_code = 'Недостача'           THEN 'недостача'
        WHEN problem_code = 'Отказано в возврате' THEN 'другое'
        WHEN problem_code = 'Дефект поставщика'   THEN 'другое'
        WHEN problem_code = 'Потери'              THEN 'недостача'
        WHEN problem_code = 'Зависший товар' THEN 'недостача 30д'
        ELSE problem_code
    END                                     AS "Отклонение",
    problem_code as "Отклонение из источника",
    sklad                                   AS "Склад",
    storerkey                               AS "Заказчик",
    type                                    AS "type",
    stage                                   AS "stage",
    problem_code                            AS "problem_code",

    claim_ct                                AS "Количество отклонений",
    claim_qty                               AS "Кол-во шт в отклонении",
    claim_price                             AS "Сумма в руб. отклонений",

    employee_name                           AS "ФИО сотрудника",
    employee_id                             AS "ID сотрудника",
    CONCAT(employee_id, ' ', employee_name) AS "Сотрудник",
    workstation                             AS "Рабочее место"
FROM SOURCE_DWC_DETAIL) , 
receipt_problems_2 AS (
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
    FROM receipt_problems_2 rp
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
        "Отклонение" as "Отклонение из источника",
        'DWC' AS "Склад",
        COALESCE(CUSTOMERNAME,'EMEX') AS "Заказчик",
        'Склад' AS "Виновник",

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
        'Не было движений 30+ дней' as "Отклонение из источника",
        'DWC' AS "Склад",
        COALESCE(o.CUSTOMERNAME,'EMEX') AS "Заказчик",
        'Склад' AS "Виновник",
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
dwc_supplier_receipt_defects AS (
    SELECT
        "ДатаВремя",
        "День",
        "Неделя",
        "Час",
        CASE WHEN "Час" BETWEEN 8 AND 20 THEN 1 ELSE 2 END AS "Смена",

        CASE
            WHEN stage = 'RECEIPTING' THEN 'Приемка'
            WHEN stage = 'PICK'       THEN 'Подбор'
            WHEN stage = 'PLACE'      THEN 'Размещение'
            WHEN stage = 'SORT'       THEN 'Сортировка'
            WHEN stage = 'PACK'       THEN 'Упаковка'
            ELSE 'Неизвестно'
        END AS "Этап",

        CASE
            WHEN problem_code = 'Повреждение'    THEN 'По качеству'
            WHEN problem_code = 'Без маркировки' THEN 'По качеству'
            WHEN problem_code = 'Недостача'      THEN 'По количеству'
            WHEN problem_code = 'Потери'         THEN 'По количеству'
            WHEN problem_code = 'Зависший товар' THEN 'По количеству'
            ELSE problem_code
        END AS "Категория отклонения",

        CASE
            WHEN problem_code = 'Повреждение'    THEN 'повреждение'
            WHEN problem_code = 'Без маркировки' THEN 'повреждение упаковки'
            WHEN problem_code = 'Недостача'      THEN 'недостача'
            WHEN problem_code = 'Потери'         THEN 'недостача'
            WHEN problem_code = 'Зависший товар' THEN 'недостача 30д'
            ELSE problem_code
        END AS "Отклонение",
        "Отклонение" as "Отклонение из источника",
        'DWC' AS "Склад",
        'EMEX' AS "Заказчик",
         'Поставщик' AS "Виновник",
        claim_ct AS claim_ct,
        claim_qty AS claim_qty,
        COALESCE(claim_price, 0) * COALESCE(claim_ct, claim_qty, 1) AS claim_amount,

        employee_name AS "USER",
        detailname AS "Наименование",
        item_type AS "Тип товара"
    FROM SOURCE_DWC_DETAIL
),

dwc_all_defects AS (
     SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_ct, claim_qty, claim_amount,
        "USER","Наименование","Тип товара"
    FROM dwc_receipt_defects_prepared

    UNION ALL

    SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_ct, claim_qty, claim_amount,
        "USER","Наименование","Тип товара"
    FROM dwc_time_defect_events

    UNION ALL

    SELECT
        "ДатаВремя","День","Неделя","Час","Смена",
        "Этап","Категория отклонения","Отклонение","Отклонение из источника",
        "Склад","Заказчик","Виновник",
        claim_ct, claim_qty, claim_amount,
        "USER","Наименование","Тип товара"
    FROM dwc_supplier_receipt_defects
),

    dwc_union as (
SELECT
    "ДатаВремя","День","Неделя","Час","Смена",
    "Этап","Категория отклонения","Отклонение","Отклонение из источника",
    "Склад","Заказчик",
    SUM(claim_ct)      AS "Количество отклонений",
    SUM(claim_qty)     AS "Кол-во шт в отклонении",
    SUM(claim_amount)  AS "Сумма в руб. отклонений",
    "USER","Наименование","Тип товара", "Виновник"
FROM dwc_all_defects
GROUP BY
    "ДатаВремя","День","Неделя","Час","Смена",
    "Этап","Категория отклонения","Отклонение","Отклонение из источника",
    "Склад","Заказчик","USER","Наименование","Тип товара","Виновник")

select * from BD_UNION
union all
select * from kdz_union
union all
select * from dwc_union