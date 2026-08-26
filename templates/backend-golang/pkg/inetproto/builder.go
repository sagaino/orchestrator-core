package inetproto

import (
	"context"
	"fmt"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/url"
	"reflect"
	"strings"
)

type RestRepoBuilder struct {
	Builder Statement
}

type Statement struct {
	client       HttpServer
	ctx          context.Context
	baseUrl      string
	body         interface{}
	bodyResponse interface{}
	method       string
	baseHeader   []RequestHeader
}

func NewRestRepoBuilder(url string, defaultHeader ...RequestHeader) RestRepoBuilder {
	return RestRepoBuilder{
		Builder: Statement{
			baseUrl:    url,
			baseHeader: defaultHeader,
			client:     Default(),
		},
	}
}

type QueryKeyVal struct {
	Key string
	Val string
}

func (r *Statement) WithContext(ctx context.Context) *Statement {
	r.ctx = ctx
	return r
}

func (r *Statement) Post(path string, args ...QueryKeyVal) *Statement {
	var url = r.baseUrl + path
	query := "?"
	for _, arg := range args {
		query += fmt.Sprintf("&%s=%s", arg.Key, arg.Val)
	}
	if len(args) > 0 {
		url += query
	}
	r.baseUrl = url
	r.method = http.MethodPost
	return r
}

func (r *Statement) Header(headers ...RequestHeader) *Statement {
	r.baseHeader = append(r.baseHeader, headers...)
	return r
}

func (r *Statement) BodyJSON(body interface{}) *Statement {
	r.baseHeader = append(r.baseHeader, RequestHeader{
		Key:   "Content-Type",
		Value: gin.MIMEJSON,
	})
	r.body = body
	return r
}

func (r *Statement) BodyMultipart(body interface{}) *Statement {
	r.baseHeader = append(r.baseHeader, RequestHeader{
		Key:   "Content-Type",
		Value: gin.MIMEPOSTForm,
	})
	r.body = body
	return r
}

func (r *Statement) BodyResponse(body interface{}) *Statement {
	r.bodyResponse = body
	return r
}

func (r *Statement) Send() error {
	if reflect.TypeOf(r.bodyResponse).Kind() != reflect.Pointer {
		return fmt.Errorf("body Response struct should be Pointer of struct")
	}

	if r.ctx == nil {
		r.ctx = context.Background()
	}

	request, err := r.client.CreateRequest(
		r.ctx,
		r.baseHeader,
		r.method,
		r.baseUrl,
		r.body,
	)
	if err != nil {
		return err
	}

	fmt.Printf("Sending request to %s\n", r.baseUrl)
	res, err := r.client.Do(request)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		fmt.Printf("Getting error while hit %s %s => %s\n", request.Method, request.URL, res.Status)
	}

	err = r.client.BindResponse(res, r.bodyResponse)
	if err != nil {
		return err
	}

	baseUrl, err := url.Parse(r.baseUrl)
	if err != nil {
		return err
	}
	r.baseUrl = strings.ToLower(baseUrl.Scheme) + baseUrl.Host
	r.baseHeader = r.baseHeader[:1]
	r.ctx = nil
	r.body = nil
	r.bodyResponse = nil

	return nil
}
