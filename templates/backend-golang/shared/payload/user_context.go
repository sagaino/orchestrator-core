package payload

import (
	"encoding/json"
	"time"
)

type UserData struct {
	UserId   string         `json:"userId"`
	Lang     string         `json:"lang"`
	Timezone string         `json:"timezone"`
	Tz       *time.Location `json:"tz"`
	Email    string         `json:"email"`
	RoleName string         `json:"roleName"`
}

func (authData *UserData) LoadFromMap(m map[string]interface{}) error {
	data, err := json.Marshal(m)

	if err == nil {
		err = json.Unmarshal(data, authData)
	}
	return err
}

type SessionDataUser struct {
	ID            uint      `json:"id"`
	Code          string    `json:"code"`
	UserReference string    `json:"userReference"`
	RoleName      string    `json:"roleName"`
	TimeZone      string    `json:"timeZone"`
	Lang          string    `json:"lang"`
	PhoneNumber   string    `json:"phoneNumber"`
	Email         string    `json:"email"`
	Name          string    `json:"name"`
	IsVerified    bool      `json:"isVerified"`
	ProfileImage  string    `json:"profileImage"`
	LastActive    time.Time `json:"lastActive"`
}

type ctxKey string

const AuthCodeContext = ctxKey("authCode")
