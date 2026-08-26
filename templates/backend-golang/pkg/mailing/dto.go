package mailing

type NativeSendEmailPayload struct {
	Host     string `json:"host"`
	Port     string `json:"base"`
	Subject  string `json:"subject"`
	Username string `json:"username"`
	Password string `json:"password"`
	SendTo   string `json:"sendTo"`
	HtmlBody string `json:"htmlBody"`
}
