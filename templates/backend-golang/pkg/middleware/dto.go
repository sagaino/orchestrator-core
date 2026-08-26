package middleware

import (
	"encoding/json"

	"github.com/golang-jwt/jwt/v4"
)

var (
	CtxKeySession = "auth.middleware"
	KeyBranchID   = "branchId"

	// Session Check Middleware
	RequestParams   = "request-params"
	RequestQuery    = "request-query"
	RequestBodyJSON = "request-body-json"

	// Role Name
	RoleUser  = "user"
	RoleAdmin = "admin"
)

type DefaultUserClaim struct {
	UserData UserData `json:"userData"`
	jwt.RegisteredClaims
}

type TestStruct struct {
	Nama string `json:"nama" validate:"required"`
}

type UserData struct {
	UserId      string `json:"userId"`
	Lang        string `json:"lang"`
	LangContent string `json:"langContent"`
	Email       string `json:"email"`
	RoleName    string `json:"roleName"`
}

func (authData *UserData) LoadFromMap(m map[string]interface{}) error {
	data, err := json.Marshal(m)
	if err == nil {
		err = json.Unmarshal(data, authData)
	}
	return err
}
