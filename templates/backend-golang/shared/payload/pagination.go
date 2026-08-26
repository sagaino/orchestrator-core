package payload

type Pagination struct {
	PerPage      int `json:"perPage"`
	Total        int `json:"total"`
	CurrentPage  int `json:"currentPage"`
	PreviousPage int `json:"previousPage"`
	NextPage     int `json:"nextPage"`
}

type PaginationResponse[T any] struct {
	Data       []T        `json:"data"`
	Pagination Pagination `json:"pagination"`
}

func NewPagination[T any](data []T, total int, perPage int, page int) PaginationResponse[T] {
	pagination := Pagination{
		PerPage:     perPage,
		Total:       total,
		CurrentPage: page,
	}
	pagination.Evaluate()
	return PaginationResponse[T]{
		Data:       data,
		Pagination: pagination,
	}
}

type SummaryStatus struct {
	Label string `json:"label"`
	Type  string `json:"type"`
}

type FilterMapping struct {
	ID    uint   `json:"id"`
	Label string `json:"label"`
	Value string `json:"value"`
}

func (r *Pagination) Evaluate() {
	if r.CurrentPage-1 > 0 {
		r.PreviousPage = r.CurrentPage - 1
	}

	if (r.CurrentPage * r.PerPage) < r.Total {
		r.NextPage = r.CurrentPage + 1
	}

}
