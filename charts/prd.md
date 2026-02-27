Goal
To quickly experiment with data vizualizations

Architecture
Mostly frontend, backed only serves data
We will have an sqllite db built from a csv

Frontend
We will build different charts on this data

Overall data
Dimensions	Время	[Абсолютное / Час / Смена / День / Неделя / Месяц / Квартал / Год]
разрезы	Заказчик	
	Склад	
	Зона	[Вход / Выход / Зона отгрузки]
	Этап	Разгрузка / Приемка / Размещение / 
	Тип товара	
	Сотрудник	
	Тип отклонения:	[Временное / Количественное / Качественное]
		
Measures	Событие	
метрики	Шт	
		
	Время операции	
	Нормативное время	
	Время простоя	
		
	Стоимость	
		
	Потери во времени	за счет отклонений
	Потери в деньгах	за счет отклонений
		
Derivative measures	Производительность	Время / Нормативное время
производные метрики	Утилизация	Время операции / (Время операции + Время простоя)
	Опоздания	% Время операции < Нормативное время


Frontend
Charts — recharts
treemap

when building treemap — dimensions should be selectable (multiselect)
measure should be selectable 

