package constant

const (
	ContextApp = "APP"
	ContextWeb = "WEB"

	//	PeriodFormatted type on PaymentRepo.GetReportOmsetByPeriod
	PeriodTypeMonth = "MONTH"
	PeriodTypeDay   = "DAY"

	// Session Check Middleware
	RequestParams   = "request-params"
	RequestQuery    = "request-query"
	RequestBodyJSON = "request-body-json"

	//	Chekmutasi
	CheckMutation       = "CHECK.MUTATION"
	BankIsBCA           = "bca"
	BankAccountIDBCA    = "8692259300"
	CMReferenceIsAmount = "amount"
	CMResponseFaildMsg  = "failed"
	CMTypeDebit         = "D"
	CMTypeCredit        = "K"

	//	Content-Type
	MIMEPNG  = "image/png"
	MIMEJPG  = "image/jpg"
	MIMEJPEG = "image/jpeg"
	MIMEPDF  = "application/pdf"
	MIMEXLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)
