package middleware

type SessionDataUser struct {
	UserReference string `json:"userReference"`
	RoleName      string `json:"roleName"`
	TimeZone      string `json:"timeZone"`
}
