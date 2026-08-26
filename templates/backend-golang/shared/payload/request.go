package payload

import (
	"base-be-golang/internal/constant"
	"fmt"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

type GetListQueryNoPeriod struct {
	PerPage      int       `bindQuery:"dataType=integer" json:"perPage"`
	Page         int       `bindQuery:"dataType=integer" json:"page"`
	Search       string    `json:"search"`
	Date         time.Time `bindQuery:"dataType=timestamp" json:"date"`
	TimeZone     string    `json:"-"`
	ResponseType string
}

func (l *GetListQueryNoPeriod) SetIfEmpty() {
	if l.Page == 0 {
		l.Page = 1
	}

	if l.PerPage == 0 {
		l.PerPage = 15
	}

}

type GetListQuery struct {
	PerPage      int          `json:"perPage"`
	Page         int          `json:"page"`
	Search       string       `json:"search"`
	Date         time.Time    `json:"date"`
	FilterPeriod FilterPeriod `validate:"dive" json:"filterPeriod"`
	TimeZone     string       `json:"-"`
	ResponseType string
}

type Sorting struct {
	CreatedAt string `json:"createdAt" validate:"enum=ASC DESC"`
}

type FilterPeriod struct {
	Year       int       `json:"year" validate:"omitempty,gte=2022,lte=2100"`
	Month      string    `json:"month" validate:"omitempty,monthyearformat"`
	StartDate  time.Time `json:"startDate"`
	EndDate    time.Time `json:"endDate"`
	PeriodType string    `json:"periodType"`
}

func NewGetListQueryFromContext(c *gin.Context, rules map[string]any) (GetListQuery, error) {
	var query = GetListQuery{
		Search: c.Query("search"),
		FilterPeriod: FilterPeriod{
			Month:      c.Query("month"),
			PeriodType: c.Query("periodType"),
		},
	}

	if c.Query("year") != "" {
		year, err := strconv.ParseInt(c.Query("year"), 10, 64)
		if err != nil {

			return GetListQuery{}, fmt.Errorf("format year tidak valid")
		}
		query.FilterPeriod.Year = int(year)
	}

	var dateStartParams, timeFormat string
	if val, ok := rules["dateStartParams"]; ok {
		dateStartParams = val.(string)
	}

	if val, ok := rules["timeFormat"]; ok {
		timeFormat = val.(string)
	}

	if c.Query(dateStartParams) != "" {
		dateStart, err := time.Parse(timeFormat, c.Query(dateStartParams))
		if err != nil {

			return GetListQuery{}, fmt.Errorf("format dateStart tidak valid")
		}
		query.FilterPeriod.StartDate = dateStart
	}

	var endDateParams string
	if val, ok := rules["endDateParams"]; ok {
		endDateParams = val.(string)
	}

	if c.Query(endDateParams) != "" {
		dateFinish, err := time.Parse(timeFormat, c.Query(endDateParams))
		if err != nil {

			return GetListQuery{}, fmt.Errorf("format dateFinish tidak valid")
		}
		query.FilterPeriod.EndDate = dateFinish
	}

	if c.Query("perPage") != "" {
		perPage, err := strconv.ParseInt(c.Query("perPage"), 10, 64)
		if err != nil {

			return GetListQuery{}, fmt.Errorf("format perPage tidak valid")
		}
		query.PerPage = int(perPage)
	}

	if c.Query("date") != "" {
		date, err := time.Parse(timeFormat, c.Query("date"))
		if err != nil {

			return GetListQuery{}, fmt.Errorf("format date tidak valid")
		}
		query.Date = date
	}

	if c.Query("page") != "" {
		page, err := strconv.ParseInt(c.Query("page"), 10, 64)
		if err != nil {

			return GetListQuery{}, fmt.Errorf("format page tidak valid")
		}
		query.Page = int(page)
	}

	if (query.FilterPeriod.Month != "" &&
		(query.FilterPeriod.StartDate != (time.Time{}) ||
			query.FilterPeriod.EndDate != (time.Time{}))) ||
		(query.FilterPeriod.Month != "" &&
			query.FilterPeriod.Year != 0) ||
		(query.FilterPeriod.Year != 0 &&
			(query.FilterPeriod.StartDate != (time.Time{}) ||
				query.FilterPeriod.EndDate != (time.Time{}))) {
		return GetListQuery{}, constant.ErrQueryPeriod
	}

	return query, nil
}

type GetListExpanseQuery struct {
	GetListQuery
	CategoryID int    `json:"categoryId"`
	DanaSource string `json:"danaSource"`
}

type GetListServiceQuery struct {
	GetListQuery
	UnitName string `json:"UnitName"`
}

type GetListTransactionQuery struct {
	GetListQuery
	Sorting
	CustomerID        uint   `json:"CustomerId"`
	PaymentMethod     string `json:"paymentMethod"`
	PaymentStatus     string `json:"paymentStatus"`
	JenisTransaksi    string `json:"jenisTransaksi"`
	TransactionStatus string `json:"transactionStatus"`
	ActionType        string `json:"actionType"`
}

func NewGetListTransactionQueryFromContext(c *gin.Context, rules map[string]interface{}) (GetListTransactionQuery, error) {
	var query = GetListTransactionQuery{
		Sorting: Sorting{
			CreatedAt: c.Query("sortCreatedAt"),
		},
		PaymentMethod:     c.Query("paymentMethod"),
		PaymentStatus:     c.Query("paymentStatus"),
		TransactionStatus: c.Query("transactionStatus"),
		JenisTransaksi:    c.Query("jenisTransaksi"),
	}

	if query.Sorting.CreatedAt == "" {
		query.Sorting.CreatedAt = "DESC"
	}

	if c.Param("customerId") != "" {
		custId, err := strconv.ParseUint(c.Param("customerId"), 10, 64)
		if err != nil {

			return GetListTransactionQuery{}, fmt.Errorf("format customerId tidak valid")
		}
		query.CustomerID = uint(custId)
	}

	baseQuery, err := NewGetListQueryFromContext(c, rules)
	if err != nil {
		return GetListTransactionQuery{}, err
	}
	query.GetListQuery = baseQuery

	return query, nil
}

func (t GetListQuery) GetDateRange(tz *time.Location) (time.Time, time.Time) {
	var (
		month int
		year  int
	)

	_, err := fmt.Sscanf(t.FilterPeriod.Month, "%d-%d", &month, &year)
	if err != nil {
		return time.Time{}, time.Time{}
	}

	return time.Date(year, time.Month(month), 1, 0, 0, 0, 1, tz),
		time.Date(year, time.Month(month+1), -1, 23, 59, 59, 59, tz)

}
