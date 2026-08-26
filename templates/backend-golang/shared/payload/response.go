package payload

import "net/http"

type Response struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Result  any    `json:"result"`
}

type ErrorResponse struct {
	Code        int    `json:"code"`
	Message     string `json:"message"`
	Result      any    `json:"result"`
	ErrorServer string `json:"errorServer,omitempty"`
	Errors      any    `json:"errors,omitempty"`
}

func DefaultErrorResponse(err error) *ErrorResponse {
	return DefaultErrorResponseWithMessage("Internal Error", err)
}

func DefaultErrorResponseWithMessage(msg string, err error) *ErrorResponse {
	errStr := ""
	if err != nil {
		errStr = err.Error()
	}
	return &ErrorResponse{
		Code:        http.StatusInternalServerError,
		Message:     msg,
		Result:      nil,
		ErrorServer: errStr,
	}
}

func DefaultErrorInvalidDataWithMessage(msg string) *ErrorResponse {
	return &ErrorResponse{
		Code:    http.StatusBadRequest,
		Message: msg,
		Result:  nil,
	}
}

func DefaultErrorInvalidDataWithCode(code int, msg string) *ErrorResponse {
	return &ErrorResponse{
		Code:    code,
		Message: msg,
		Result:  nil,
	}
}

func DefaultDataInvalidResponse(validationErrors any) *ErrorResponse {
	return &ErrorResponse{
		Code:    http.StatusBadRequest,
		Message: "Data invalid.",
		Result:  nil,
		Errors:  validationErrors,
	}
}

func DefaultBadRequestResponse() *ErrorResponse {
	return &ErrorResponse{
		Code:    http.StatusBadRequest,
		Message: "Bad request",
		Result:  nil,
	}
}

func DefaultInvalidInputFormResponse(errs map[string][]string) *Response {
	var msg string
	for _, val := range errs {
		if len(val) > 0 {
			msg = val[0]
			break
		}
	}
	if msg == "" {
		msg = "Invalid input"
	}

	return &Response{
		Code:    http.StatusBadRequest,
		Message: msg,
		Result:  errs,
	}
}

func NewSuccessResponseNoMsg(data any) *Response {
	return &Response{
		Code:    http.StatusOK,
		Message: "OK",
		Result:  data,
	}
}

func NewSuccessResponseNoData(msg string) *Response {
	return &Response{
		Code:    http.StatusOK,
		Message: msg,
		Result:  struct{}{},
	}
}

func NewSuccessResponse(data any, msg string) *Response {
	return &Response{
		Code:    http.StatusOK,
		Message: msg,
		Result:  data,
	}
}
