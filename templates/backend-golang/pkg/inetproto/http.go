//go:generate mockery --all --inpackage --case snake

package inetproto

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"golang.org/x/exp/slices"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
)

type HttpServer struct {
	Client *http.Client
}

func Default() HttpServer {
	return HttpServer{
		Client: http.DefaultClient,
	}
}

type HttpInterface interface {
	Do(req *http.Request) (*http.Response, error)
	BindResponse(res *http.Response, payload any) error
	ReadRequest(req any) io.Reader
	NewRequestWithContext(
		ctx context.Context,
		method, url string,
		body io.Reader,
	) (*http.Request, error)
	CreateRequest(
		ctx context.Context,
		header []RequestHeader,
		method string,
		url string,
		body any,
	) (*http.Request, error)
}

type RequestHeader struct {
	Key   string
	Value string
}

func (h HttpServer) convertToUrlFormData(data interface{}) (io.Reader, error) {
	forms := url.Values{}
	dType := reflect.TypeOf(data)
	dValue := reflect.ValueOf(data)

	if data == nil {
		return nil, nil
	}

	if dType.Kind() == reflect.Struct {
		for i := 0; i < dType.NumField(); i++ {
			key := dType.Field(i).Tag.Get("json")
			stval := dValue.Field(i)

			if str, ok := stval.Interface().(string); ok {
				forms.Set(key, str)
				continue
			}

			kind := dValue.Field(i).Kind()
			switch {
			case slices.Contains(TypeIsInt, kind):
				forms.Set(key, strconv.FormatInt(stval.Int(), 10))
				continue
			case slices.Contains(TypeIsUint, kind):
				forms.Set(key, strconv.FormatUint(stval.Uint(), 10))
				continue
			case slices.Contains(TypeIsFloat, kind):
				forms.Set(key, strconv.FormatFloat(stval.Float(), 'f', -1, 32))
				continue
			default:
				return nil, fmt.Errorf("invalid data type")
			}
		}

		p := strings.NewReader(forms.Encode())
		return p, nil
	}

	return nil, fmt.Errorf("only accept struct type")
}

func (h HttpServer) CreateRequest(
	ctx context.Context,
	header []RequestHeader,
	method string,
	url string,
	body any,
) (*http.Request, error) {
	var (
		bodyReq io.Reader
		err     error
	)

	var contenType string
	for _, hd := range header {
		if hd.Key == "Content-Type" {
			contenType = hd.Value
		}
	}
	if body != nil {
		switch contenType {
		case gin.MIMEPOSTForm:
			bodyReq, err = h.convertToUrlFormData(body)
			if err != nil {

				return nil, err
			}
			break

		case gin.MIMEMultipartPOSTForm:
			bodyReq, err = h.convertToUrlFormData(body)
			if err != nil {

				return nil, err
			}
			break
		case gin.MIMEJSON:
			bodyReq = h.ReadRequest(body)
			if body == nil {
				bodyReq = nil
			}
			break
		default:
			bodyReq = body.(io.ReadCloser)
			break
		}
	}

	req, err := h.NewRequestWithContext(
		ctx,
		method,
		url,
		bodyReq,
	)
	if err != nil {

		return nil, err
	}

	for _, h := range header {
		req.Header.Set(h.Key, h.Value)
	}

	return req, nil
}

func (h HttpServer) NewRequestWithContext(
	ctx context.Context,
	method, url string,
	body io.Reader,
) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, method, url, body)
}

func (h HttpServer) ReadRequest(req any) io.Reader {
	payloadBytes, err := json.Marshal(req)
	op := "utils.http.ReadRequest:"
	if err != nil {

		fmt.Println(op, err)
		return nil
	}
	return bytes.NewBuffer(payloadBytes)
}

func (h HttpServer) Do(req *http.Request) (*http.Response, error) {
	return h.Client.Do(req)
}

func (h HttpServer) BindResponse(res *http.Response, payload any) error {
	body, err := io.ReadAll(res.Body)
	op := "utils.http.BindResponse:"
	if err != nil {
		fmt.Println(op, err)
		return err
	}

	err = json.Unmarshal(body, payload)
	if err != nil {
		fmt.Println(op, err)
		return err
	}

	return nil
}
