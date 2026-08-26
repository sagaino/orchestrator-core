package inetproto

import (
	"context"
	"net/http"
	"slices"
)

type RestRepoTemplate struct {
	baseUrl    string
	baseHeader []RequestHeader
	client     HttpServer
}

func NewRestRepoTemplate(baseUrl string, header ...RequestHeader) RestRepoTemplate {
	return RestRepoTemplate{
		baseUrl:    baseUrl,
		baseHeader: header,
		client:     Default(),
	}
}

func (g RestRepoTemplate) Post(ctx context.Context, path string, request interface{}, header []RequestHeader) (map[string]interface{}, error) {
	url := g.baseUrl + path

	var finalHeader []RequestHeader
	if len(header) > 0 {
		finalHeader = slices.Concat(g.baseHeader, header)
	} else {
		finalHeader = g.baseHeader
	}
	req, err := g.client.CreateRequest(
		ctx,
		finalHeader,
		http.MethodPost,
		url,
		request,
	)
	if err != nil {
		return nil, err
	}
	res, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	var response = map[string]any{}
	err = g.client.BindResponse(res, &response)
	if err != nil {
		return nil, err
	}

	return response, nil
}
