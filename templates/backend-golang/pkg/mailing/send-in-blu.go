//go:generate mockery --all --inpackage --case snake

package mailing

import (
	"fmt"
	"net/smtp"
)

type SendInBlue struct {
}

func NewConfig() SendInBlue {
	return SendInBlue{}
}

func (sib SendInBlue) NativeSendEmail(payload NativeSendEmailPayload) error {
	auth := smtp.PlainAuth("", payload.Username, payload.Password, payload.Host)
	messageBody := fmt.Sprintf(
		"From:  <%s>\n"+
			"To: <%s>\r\n"+
			"Subject: %s\r\n",
		payload.Username,
		payload.SendTo,
		payload.Subject,
	)
	messageBody += "MIME-version: 1.0;\r\n"
	messageBody += "Content-Type: text/html; charset=\"UTF-8\"\r\n"
	messageBody += payload.HtmlBody

	err := smtp.SendMail(
		payload.Host+":"+payload.Port,
		auth,
		payload.Username,
		[]string{payload.SendTo},
		[]byte(messageBody),
	)
	if err != nil {

		return err
	}

	return nil
}
